import { spawn } from "node:child_process";
import type WebSocket from "ws";
import { regenerateConversationDescription } from "@/agent/conversation-description";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "@/agent/max-context";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { REMEMBER_PROMPT } from "@/agent/prompt-assets";
import type { ConversationMessageCompactBody } from "@/backend";
import { getBackend } from "@/backend";
import { refreshCustomCommands } from "@/cli/commands/custom";
import { formatErrorDetails } from "@/cli/helpers/error-formatter";
import {
  buildDoctorMessage,
  buildInitMessage,
  gatherInitGitContext,
} from "@/cli/helpers/init-command";
import { getReflectionSettings } from "@/cli/helpers/memory-reminder";
import { buildModCommandPrompt } from "@/cli/mods/command-runtime";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { runPreCompactHooks } from "@/hooks";
import type { ModCommand } from "@/mods/types";
import { settingsManager } from "@/settings-manager";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type {
  ExecuteCommandCommand,
  SlashCommandEndMessage,
  SlashCommandStartMessage,
  StreamDelta,
} from "@/types/protocol_v2";
import { debugLog } from "@/utils/debug";
import { markSecretsReminderRefreshPending } from "./commands/secrets";
import { getConversationWorkingDirectory } from "./cwd";
import { reloadListenerModAdapter } from "./mod-adapter";
import { getListenerModCommand, runListenerModCommand } from "./mod-commands";
import {
  createLifecycleMessageBase,
  emitCanonicalMessageDelta,
  emitDeviceStatusUpdate,
} from "./protocol-outbound";
import { clearConversationRuntimeState, emitListenerStatus } from "./runtime";
import {
  ensureSecretsHydratedForAgent,
  invalidateSecretsCacheForAgent,
} from "./secrets-sync";
import {
  buildMaybeLaunchReflectionSubagent,
  handleIncomingMessage,
} from "./turn";
import type { ConversationRuntime, StartListenerOptions } from "./types";

export { SUPPORTED_REMOTE_COMMANDS } from "./listener-constants";

/**
 * Handle an `execute_command` message from the web app.
 *
 * Dispatches to the appropriate command handler based on `command_id`.
 * Results flow back as `slash_command_start` / `slash_command_end`
 * stream deltas so they appear in the web UMI message list.
 */
export async function handleExecuteCommand(
  command: ExecuteCommandCommand,
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    onLog?: StartListenerOptions["onLog"];
    connectionId?: string;
    connectionName?: string;
  },
): Promise<void> {
  const scope = {
    agent_id: conversationRuntime.agentId,
    conversation_id: conversationRuntime.conversationId,
  };

  const trimmedArgs = command.args?.trim();
  const input = trimmedArgs
    ? `/${command.command_id} ${trimmedArgs}`
    : `/${command.command_id}`;

  // Emit slash_command_start
  const startDelta: SlashCommandStartMessage = {
    ...createLifecycleMessageBase("slash_command_start"),
    command_id: command.command_id,
    input,
  };
  emitCanonicalMessageDelta(
    socket,
    conversationRuntime,
    startDelta as StreamDelta,
    scope,
  );

  try {
    let output: string;

    switch (command.command_id) {
      case "clear":
        output = await handleClearCommand(socket, conversationRuntime, opts);
        break;

      case "doctor":
        output = await handleDoctorCommand(socket, conversationRuntime, opts);
        break;

      case "init":
        output = await handleInitCommand(socket, conversationRuntime, opts);
        break;

      case "remember":
        output = await handleRememberCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
          opts,
        );
        break;

      case "compact":
        output = await handleCompactCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
        );
        break;

      case "reload":
        output = await handleReloadCommand(conversationRuntime);
        // Re-advertise so newly (un)registered mod commands reach the client.
        emitDeviceStatusUpdate(socket, conversationRuntime, scope);
        break;

      case "context-limit":
      case "set-max-context":
        output = await handleSetMaxContextCommand(
          conversationRuntime,
          trimmedArgs,
        );
        break;

      case "channels":
        output = await handleChannelsCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
          opts,
        );
        break;

      case "upgrade-letta-code":
        output = await handleUpgradeLettaCodeCommand(opts);
        break;

      default: {
        const modCommand = getListenerModCommand(
          conversationRuntime.listener,
          command.command_id,
        );
        if (!modCommand) {
          emitSlashCommandEnd(socket, conversationRuntime, scope, {
            command_id: command.command_id,
            input,
            output: `Unknown command: ${command.command_id}`,
            success: false,
          });
          return;
        }
        await handleModCommand(
          modCommand,
          command,
          input,
          trimmedArgs,
          socket,
          conversationRuntime,
          scope,
          opts,
        );
        return;
      }
    }

    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output,
      success: true,
    });
  } catch (error) {
    trackBoundaryError({
      errorType: "listener_execute_command_failed",
      error,
      context: "listener_command_execution",
    });
    const errorMessage = error instanceof Error ? error.message : String(error);
    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output: `Failed: ${errorMessage}`,
      success: false,
    });
  } finally {
    // clearConversationRuntimeState sets cancelRequested = true which
    // permanently blocks the queue pump (getListenerBlockedReason returns
    // "interrupt_in_progress"). Reset it so subsequent user messages drain.
    conversationRuntime.cancelRequested = false;
  }
}

/**
 * Run a mod-registered slash command and surface its result. Mirrors the TUI
 * mod command path: `output` is shown as command output, `handled` closes
 * silently, and `prompt` injects a user turn through the normal message flow.
 */
async function handleModCommand(
  modCommand: ModCommand,
  command: ExecuteCommandCommand,
  input: string,
  trimmedArgs: string | undefined,
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<void> {
  const result = await runListenerModCommand(conversationRuntime, modCommand, {
    commandId: command.command_id,
    args: trimmedArgs ?? "",
    rawInput: input,
  });

  if (result.type === "prompt") {
    if (!modCommand.showInTranscript) {
      emitSlashCommandEnd(socket, conversationRuntime, scope, {
        command_id: command.command_id,
        input,
        output: `/${modCommand.id} returned a prompt with showInTranscript: false. Hidden mod commands must return output or handled.`,
        success: false,
      });
      return;
    }

    const agentId = conversationRuntime.agentId;
    if (!agentId) {
      emitSlashCommandEnd(socket, conversationRuntime, scope, {
        command_id: command.command_id,
        input,
        output: `No agent available to run /${modCommand.id}.`,
        success: false,
      });
      return;
    }

    emitSlashCommandEnd(socket, conversationRuntime, scope, {
      command_id: command.command_id,
      input,
      output: `Running /${modCommand.id}...`,
      success: true,
    });

    await handleIncomingMessage(
      {
        type: "message",
        agentId,
        conversationId: conversationRuntime.conversationId,
        messages: [
          {
            type: "message",
            role: "user",
            content: [{ type: "text", text: buildModCommandPrompt(result) }],
          },
        ],
      },
      socket,
      conversationRuntime,
      opts.onStatusChange,
      opts.connectionId,
    );
    return;
  }

  emitSlashCommandEnd(socket, conversationRuntime, scope, {
    command_id: command.command_id,
    input,
    output: result.type === "output" ? result.output : "",
    success: result.type === "output" ? (result.success ?? true) : true,
  });
}

async function handleReloadCommand(
  conversationRuntime: ConversationRuntime,
): Promise<string> {
  const { listener } = conversationRuntime;
  settingsManager.clearCaches();
  await settingsManager.loadProjectSettings();
  await settingsManager.loadLocalProjectSettings();

  try {
    refreshCustomCommands();
  } catch (error) {
    debugLog(
      "commands",
      "refreshCustomCommands failed during /reload:",
      error instanceof Error ? error.message : String(error),
    );
  }

  await reloadListenerModAdapter(listener);

  if (conversationRuntime.agentId) {
    invalidateSecretsCacheForAgent(listener, conversationRuntime.agentId);
    markSecretsReminderRefreshPending(listener, conversationRuntime.agentId);
    await ensureSecretsHydratedForAgent(listener, conversationRuntime.agentId);
  }

  return "Reloaded settings, local mods, and agent secrets";
}

async function handleUpgradeLettaCodeCommand(opts: {
  onLog?: StartListenerOptions["onLog"];
  connectionName?: string;
}): Promise<string> {
  const log = (message: string) => {
    const line = `[upgrade-letta-code] ${message}`;
    if (opts.onLog) {
      opts.onLog(line);
    } else {
      console.log(line);
    }
  };

  log(
    `command received (connectionName=${opts.connectionName ?? "unknown"}, execPath=${process.execPath}, entrypoint=${process.argv[1] ?? "unknown"})`,
  );
  const { manualUpdate } = await import("@/updater/auto-update");
  log("starting manualUpdate()");
  const result = await manualUpdate({ progressLog: log });
  log(
    `manualUpdate() completed: success=${result.success}; message=${result.message}`,
  );

  if (!result.success) {
    log(`upgrade failed: ${result.message}`);
    throw new Error(result.message);
  }

  if (!result.message.startsWith("Updated to ")) {
    log("no restart scheduled because no update was installed");
    return result.message;
  }

  scheduleRemoteRestart(opts.connectionName, log);
  return `${result.message}\nRestarting remote listener...`;
}

function scheduleRemoteRestart(
  connectionName: string | undefined,
  log: (message: string) => void,
): void {
  const entrypoint = process.argv[1];
  if (!entrypoint || !connectionName) {
    log(
      `restart skipped (entrypoint=${entrypoint ?? "missing"}, connectionName=${connectionName ?? "missing"})`,
    );
    return;
  }

  log(`scheduling remote listener restart for env ${connectionName}`);
  setTimeout(() => {
    log(
      `spawning replacement listener: ${process.execPath} ${entrypoint} remote --env-name ${connectionName}`,
    );
    const child = spawn(
      process.execPath,
      [entrypoint, "remote", "--env-name", connectionName],
      {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: "ignore",
      },
    );
    log(
      `spawned replacement listener pid=${child.pid ?? "unknown"}; exiting current listener`,
    );
    child.unref();
    process.exit(0);
  }, 1000).unref();
}

function emitSlashCommandEnd(
  socket: WebSocket,
  runtime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  fields: Pick<
    SlashCommandEndMessage,
    "command_id" | "input" | "output" | "success"
  >,
): void {
  const endDelta: SlashCommandEndMessage = {
    ...createLifecycleMessageBase("slash_command_end"),
    ...fields,
  };
  emitCanonicalMessageDelta(socket, runtime, endDelta as StreamDelta, scope);
}

type CompactMode =
  | "all"
  | "sliding_window"
  | "self_compact_all"
  | "self_compact_sliding_window";

const VALID_COMPACT_MODES = new Set<CompactMode>([
  "all",
  "sliding_window",
  "self_compact_all",
  "self_compact_sliding_window",
]);

function compactHelpOutput(): string {
  return [
    "/compact help",
    "",
    "Summarize conversation history (compaction).",
    "",
    "USAGE",
    "  /compact                   — compact with default mode",
    "  /compact all               — compact all messages",
    "  /compact sliding_window    — compact with sliding window",
    "  /compact self_compact_all  — compact with self compact all",
    "  /compact self_compact_sliding_window  — compact with self compact sliding window",
    "  /compact help              — show this help",
  ].join("\n");
}

/** /compact — Summarize conversation history through the active Backend. */
async function handleCompactCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /compact command");
  }

  const rawModeArg = args?.trim().split(/\s+/)[0];
  if (rawModeArg === "help") {
    return compactHelpOutput();
  }

  const modeArg = rawModeArg as CompactMode | undefined;
  if (modeArg && !VALID_COMPACT_MODES.has(modeArg)) {
    throw new Error(`Invalid mode "${modeArg}". Run /compact help for usage.`);
  }

  const preCompactResult = await runPreCompactHooks(
    undefined,
    undefined,
    agentId,
    conversationRuntime.conversationId,
  );
  if (preCompactResult.blocked) {
    const feedback = preCompactResult.feedback.join("\n") || "Blocked by hook";
    throw new Error(`Compact blocked: ${feedback}`);
  }

  const backend = getBackend();
  const modeDisplay = modeArg ? ` (mode: ${modeArg})` : "";

  try {
    let compactParams: ConversationMessageCompactBody | undefined;
    if (modeArg) {
      const agent = await backend.retrieveAgent(agentId);
      compactParams = {
        compaction_settings: {
          mode: modeArg,
          model:
            agent.compaction_settings?.model?.trim() ||
            DEFAULT_SUMMARIZATION_MODEL,
        },
      } as ConversationMessageCompactBody;
    }

    const compactBody =
      conversationRuntime.conversationId === "default"
        ? ({
            agent_id: agentId,
            ...(compactParams ?? {}),
          } as ConversationMessageCompactBody)
        : compactParams;

    const result = await backend.compactConversationMessages(
      conversationRuntime.conversationId,
      compactBody,
    );

    // Launching reflection is best-effort — never fail the /compact itself.
    try {
      const reflectionSettings = getReflectionSettings(
        agentId,
        getConversationWorkingDirectory(
          conversationRuntime.listener,
          agentId,
          conversationRuntime.conversationId,
        ),
      );
      if (
        reflectionSettings.trigger === "compaction-event" &&
        settingsManager.isMemfsEnabled(agentId)
      ) {
        void buildMaybeLaunchReflectionSubagent({
          runtime: conversationRuntime,
          socket,
          agentId,
          conversationId: conversationRuntime.conversationId,
        })("compaction-event");
      }
    } catch (reflectionError) {
      debugLog(
        "memory",
        "Skipping post-compaction reflection:",
        reflectionError instanceof Error
          ? reflectionError.message
          : String(reflectionError),
      );
    }
    void regenerateConversationDescription(conversationRuntime.conversationId);

    return [
      `Compaction completed${modeDisplay}. Message buffer length reduced from ${result.num_messages_before} to ${result.num_messages_after}.`,
      "",
      `Summary: ${result.summary}`,
    ].join("\n");
  } catch (error) {
    const apiError = error as {
      status?: number;
      error?: { detail?: string };
    };
    const detail = apiError?.error?.detail;
    if (
      apiError?.status === 400 &&
      detail?.includes("Summarization failed to reduce the number of messages")
    ) {
      return "Compaction run, but the number of messages is the same";
    }

    throw new Error(formatErrorDetails(error, agentId));
  }
}

/**
 * /clear — Reset agent messages and create a new conversation.
 *
 * Mirrors the CLI /clear logic:
 * 1. Reset agent messages (only for "default" conversation)
 * 2. Create a new conversation
 * 3. Clear the conversation runtime state
 *
 * Returns a human-readable success message.
 */
async function handleClearCommand(
  _socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const backend = getBackend();
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /clear command");
  }

  // Reset all messages on the agent only when in the default API conversation.
  // Local/headless backends model /clear by switching to a fresh conversation.
  if (
    conversationRuntime.conversationId === "default" &&
    !backend.capabilities.localModelCatalog
  ) {
    const { getClient } = await import("@/backend/api/client");
    const client = await getClient();
    await client.agents.messages.reset(agentId, {
      add_default_initial_messages: false,
    });
  }

  // Create a new conversation
  const conversation = await backend.createConversation({
    agent_id: agentId,
  });

  // Clear runtime state for the current conversation
  clearConversationRuntimeState(conversationRuntime);

  // Update the runtime's conversation ID to the new one
  conversationRuntime.conversationId = conversation.id;

  // Emit updated status so the web app picks up the new conversation
  emitListenerStatus(
    conversationRuntime.listener,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Agent's in-context messages cleared & moved to conversation history";
}

/**
 * /doctor — Audit and refine memory structure.
 *
 * Builds the doctor system-reminder message (same as the CLI /doctor)
 * and feeds it through `handleIncomingMessage` so the agent runs a full
 * turn executing the `context-doctor` skill.
 */
async function handleDoctorCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /doctor command");
  }

  const { context: gitContext } = gatherInitGitContext();
  const memoryDir = settingsManager.isMemfsEnabled(agentId)
    ? getScopedMemoryFilesystemRoot(agentId)
    : undefined;

  const doctorMessage = buildDoctorMessage({ gitContext, memoryDir });

  // Feed the doctor prompt as a user message through the normal turn pipeline.
  // This triggers a full agent turn whose deltas stream back to the web UI.
  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId: conversationRuntime.conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: doctorMessage }],
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Memory doctor completed";
}

/**
 * /init — Initialize (or re-init) agent memory.
 *
 * Builds the init system-reminder message (same as the CLI /init)
 * and feeds it through `handleIncomingMessage` so the agent runs a full
 * turn executing the `initializing-memory` skill.
 */
async function handleInitCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /init command");
  }

  const { context: gitContext } = gatherInitGitContext();
  const memoryDir = settingsManager.isMemfsEnabled(agentId)
    ? getScopedMemoryFilesystemRoot(agentId)
    : undefined;

  const initMessage = buildInitMessage({ gitContext, memoryDir });

  // Feed the init prompt as a user message through the normal turn pipeline.
  // This triggers a full agent turn whose deltas stream back to the web UI.
  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId: conversationRuntime.conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: initMessage }],
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Memory initialization completed";
}

/**
 * /remember — Store information from the conversation.
 *
 * Mirrors the CLI /remember logic by sending the remember system reminder
 * and optional user-provided text through the normal turn pipeline.
 */
async function handleRememberCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /remember command");
  }

  const hasArgs = Boolean(args && args.length > 0);
  const rememberReminder = hasArgs
    ? `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n${SYSTEM_REMINDER_CLOSE}`
    : `${SYSTEM_REMINDER_OPEN}\n${REMEMBER_PROMPT}\n\nThe user did not specify what to remember. Look at the recent conversation context to identify what they likely want you to remember, or ask them to clarify.\n${SYSTEM_REMINDER_CLOSE}`;

  const content = hasArgs
    ? [
        { type: "text" as const, text: rememberReminder },
        { type: "text" as const, text: args as string },
      ]
    : [{ type: "text" as const, text: rememberReminder }];

  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId: conversationRuntime.conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content,
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Memory request submitted";
}

/** /context-limit — Set or reset the active scope's max context window. */
async function handleSetMaxContextCommand(
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /context-limit command");
  }

  const result = await applySetMaxContext({
    agentId,
    conversationId: conversationRuntime.conversationId,
    args,
  });
  return formatSetMaxContextResult(result);
}

/**
 * /channels — Manage external channel integrations.
 *
 * Subcommands (via WS):
 *   /channels telegram pair <code>    — Approve pairing + bind chat to this agent/conversation
 *   /channels telegram enable --chat-id <id> — Bind a known chat to this agent/conversation
 *   /channels telegram disable        — Unbind this agent/conversation
 *   /channels status                  — Show channel status
 */
async function handleChannelsCommand(
  _socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
  _opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const parts = (args ?? "").trim().split(/\s+/);
  const [subCmd, action, ...rest] = parts;

  const agentId = conversationRuntime.agentId;
  const conversationId = conversationRuntime.conversationId;

  if (!agentId) {
    return "Error: No agent ID in current context.";
  }

  if (subCmd === "status") {
    const { listChannelAccountSnapshots } = await import("@/channels/service");
    const { getRoutesForChannel, loadRoutes } = await import(
      "@/channels/routing"
    );
    const { getPendingPairings, getApprovedUsers, loadPairingStore } =
      await import("@/channels/pairing");

    const channels = ["telegram"];
    const lines: string[] = [];

    for (const ch of channels) {
      const accounts = listChannelAccountSnapshots(ch);
      if (accounts.length === 0) {
        lines.push(`${ch}: not configured`);
        continue;
      }
      loadRoutes(ch);
      loadPairingStore(ch);
      const routes = getRoutesForChannel(ch);
      const pending = getPendingPairings(ch);
      const approved = getApprovedUsers(ch);
      lines.push(
        `${ch}: accounts=${accounts.length}, enabled=${accounts.some((account) => account.enabled)}, ` +
          `policy=${accounts[0]?.dmPolicy ?? "unknown"}, routes=${routes.length}, pending=${pending.length}, approved=${approved.length}`,
      );
    }

    return lines.join("\n") || "No channels configured.";
  }

  if (subCmd === "telegram") {
    const accountIdFlag = rest.indexOf("--account-id");
    const accountId =
      accountIdFlag >= 0 ? (rest[accountIdFlag + 1] ?? undefined) : undefined;

    if (action === "pair") {
      const code = rest[0];
      if (!code) {
        return "Usage: /channels telegram pair <code>";
      }

      const { completePairing } = await import("@/channels/registry");
      const { loadRoutes } = await import("@/channels/routing");
      const { loadPairingStore } = await import("@/channels/pairing");

      loadRoutes("telegram");
      loadPairingStore("telegram");

      const result = completePairing(
        "telegram",
        code,
        agentId,
        conversationId,
        accountId,
      );

      if (result.success) {
        return `Pairing approved! Chat ${result.chatId} is now bound to this agent/conversation.`;
      }
      return `Pairing failed: ${result.error}`;
    }

    if (action === "enable") {
      const chatIdFlag = rest.indexOf("--chat-id");
      const chatId = chatIdFlag >= 0 ? rest[chatIdFlag + 1] : undefined;

      if (!chatId) {
        return "Usage: /channels telegram enable --chat-id <id> [--account-id <id>]";
      }

      const { getChannelAccount, listChannelAccounts } = await import(
        "@/channels/accounts"
      );
      const { addRoute, loadRoutes } = await import("@/channels/routing");

      let resolvedAccountId = accountId?.trim();
      if (resolvedAccountId) {
        if (!getChannelAccount("telegram", resolvedAccountId)) {
          return `Unknown Telegram account: ${resolvedAccountId}`;
        }
      } else {
        const accounts = listChannelAccounts("telegram");
        if (accounts.length === 0) {
          return "Telegram is not configured yet.";
        }
        if (accounts.length > 1) {
          return "Telegram has multiple accounts. Re-run with --account-id <id>.";
        }
        resolvedAccountId = accounts[0]?.accountId;
      }

      if (!resolvedAccountId) {
        return "Could not resolve a Telegram account for this route.";
      }

      loadRoutes("telegram");
      addRoute("telegram", {
        accountId: resolvedAccountId,
        chatId,
        agentId,
        conversationId,
        enabled: true,
        createdAt: new Date().toISOString(),
      });

      return `Route created: telegram:${chatId} → ${agentId}/${conversationId}`;
    }

    if (action === "disable") {
      const { removeRoutesForScope, loadRoutes } = await import(
        "@/channels/routing"
      );

      loadRoutes("telegram");
      const removed = removeRoutesForScope("telegram", agentId, conversationId);
      return removed > 0
        ? `Removed ${removed} route(s) for this agent/conversation.`
        : "No routes found for this agent/conversation.";
    }

    return "Usage: /channels telegram <pair|enable|disable>";
  }

  return "Usage: /channels <telegram|status>";
}
