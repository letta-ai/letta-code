import type WebSocket from "ws";
import { getClient } from "../../agent/client";
import { ISOLATED_BLOCK_LABELS } from "../../agent/memory";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { REMEMBER_PROMPT } from "../../agent/promptAssets";
import {
  buildDoctorMessage,
  buildInitMessage,
  gatherInitGitContext,
} from "../../cli/helpers/initCommand";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../../constants";
import { settingsManager } from "../../settings-manager";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import type {
  ExecuteCommandCommand,
  SlashCommandEndMessage,
  SlashCommandStartMessage,
  StreamDelta,
} from "../../types/protocol_v2";
import {
  createLifecycleMessageBase,
  emitCanonicalMessageDelta,
} from "./protocol-outbound";
import { clearConversationRuntimeState, emitListenerStatus } from "./runtime";
import { handleIncomingMessage } from "./turn";
import type { ConversationRuntime, StartListenerOptions } from "./types";

/**
 * Command IDs that this letta-code version can handle via `execute_command`.
 * Advertised in DeviceStatus.supported_commands so the web UI only shows
 * commands the connected device actually supports.
 *
 * When adding a new case to `handleExecuteCommand`, add the ID here too.
 */
export const SUPPORTED_REMOTE_COMMANDS: readonly string[] = [
  "clear",
  "doctor",
  "init",
  "remember",
  "channels",
  "toolset",
];

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
    connectionId?: string;
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

      case "channels":
        output = await handleChannelsCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
          opts,
        );
        break;

      default:
        emitSlashCommandEnd(socket, conversationRuntime, scope, {
          command_id: command.command_id,
          input,
          output: `Unknown command: ${command.command_id}`,
          success: false,
        });
        return;
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
  const client = await getClient();
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /clear command");
  }

  // Reset all messages on the agent only when in the default conversation.
  if (conversationRuntime.conversationId === "default") {
    await client.agents.messages.reset(agentId, {
      add_default_initial_messages: false,
    });
  }

  // Create a new conversation
  const conversation = await client.conversations.create({
    agent_id: agentId,
    isolated_block_labels: [...ISOLATED_BLOCK_LABELS],
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
 * turn executing the `context_doctor` skill.
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
    ? getMemoryFilesystemRoot(agentId)
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
    ? getMemoryFilesystemRoot(agentId)
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
    const { listChannelAccountSnapshots } = await import(
      "../../channels/service"
    );
    const { getRoutesForChannel, loadRoutes } = await import(
      "../../channels/routing"
    );
    const { getPendingPairings, getApprovedUsers, loadPairingStore } =
      await import("../../channels/pairing");

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

      const { completePairing } = await import("../../channels/registry");
      const { loadRoutes } = await import("../../channels/routing");
      const { loadPairingStore } = await import("../../channels/pairing");

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
        "../../channels/accounts"
      );
      const { addRoute, loadRoutes } = await import("../../channels/routing");

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
        "../../channels/routing"
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
