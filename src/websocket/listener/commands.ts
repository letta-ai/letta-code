import type WebSocket from "ws";
import {
  applySetMaxContext,
  formatSetMaxContextResult,
} from "../../agent/maxContext";
import { ISOLATED_BLOCK_LABELS } from "../../agent/memory";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { REMEMBER_PROMPT } from "../../agent/promptAssets";
import type { ConversationMessageCompactBody } from "../../backend";
import { getBackend } from "../../backend";
import { formatErrorDetails } from "../../cli/helpers/errorFormatter";
import {
  buildGoalContinuationPrompt,
  formatGoalSummary,
  GOAL_USAGE,
  GOAL_USAGE_HINT,
  goalStatusLabel,
  parseGoalArgs,
  validateGoalObjective,
} from "../../cli/helpers/goalCommand";
import {
  buildDoctorMessage,
  buildInitMessage,
  gatherInitGitContext,
} from "../../cli/helpers/initCommand";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";
import { runPreCompactHooks } from "../../hooks";
import { ralphMode } from "../../ralph/mode";
import { settingsManager } from "../../settings-manager";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import type {
  ExecuteCommandCommand,
  SlashCommandEndMessage,
  SlashCommandStartMessage,
  StreamDelta,
} from "../../types/protocol_v2";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
} from "./permissionMode";
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
  "goal",
  "compact",
  "set-max-context",
  "channels",
  "toolset",
  // /secret opens the EditSecretsDialog and routes reads/writes through the
  // dedicated secret_list / secret_apply WS commands — not via
  // execute_command — so it has no case in handleExecuteCommand.
  "secret",
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

      case "goal":
        output = await handleGoalCommand(
          socket,
          conversationRuntime,
          trimmedArgs,
          opts,
        );
        break;

      case "compact":
        output = await handleCompactCommand(conversationRuntime, trimmedArgs);
        break;

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

    conversationRuntime.contextTracker.pendingReflectionTrigger = true;

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
      conversationRuntime.contextTracker.pendingReflectionTrigger = true;
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
    const { getClient } = await import("../../backend/api/client");
    const client = await getClient();
    await client.agents.messages.reset(agentId, {
      add_default_initial_messages: false,
    });
  }

  // Create a new conversation
  const conversation = await backend.createConversation({
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
 * /goal — Manage conversation goals with auto-continuation (ralph mode).
 *
 * Subcommands:
 *   /goal status              — Show current goal status
 *   /goal clear               — Clear the current goal
 *   /goal disable             — Clear goal + remove goal tools
 *   /goal pause               — Pause the active goal
 *   /goal resume              — Resume a paused goal
 *   /goal complete            — Mark the goal as complete
 *   /goal [--token-budget N] [--replace] <objective>
 *                             — Set a new goal (or replace existing)
 *
 * Mirrors the CLI /goal logic from useSubmitHandler, but uses the
 * listener's per-conversation permission mode state instead of React
 * state setters.
 */
async function handleGoalCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  const conversationId = conversationRuntime.conversationId;

  if (!agentId) {
    throw new Error("No agent ID available for /goal command");
  }

  const objective = (args ?? "").trim();
  const lowerGoalArg = objective.toLowerCase();

  // /goal, /goal status, /goal show — display current goal
  if (!objective || lowerGoalArg === "show" || lowerGoalArg === "status") {
    const goal = settingsManager.getConversationGoal(conversationId);
    if (!goal) {
      return `${GOAL_USAGE}\n${GOAL_USAGE_HINT}\nNo goal is currently set.`;
    }
    return `Goal ${goalStatusLabel(goal.status)}\n${formatGoalSummary(goal)}`;
  }

  // /goal clear or /goal disable
  if (lowerGoalArg === "clear" || lowerGoalArg === "disable") {
    const cleared = settingsManager.clearConversationGoal(conversationId);
    if (lowerGoalArg === "disable") {
      settingsManager.setConversationGoalToolsEnabled(conversationId, false);
    }
    if (ralphMode.getState().mode === "goal") {
      ralphMode.deactivate();
    }
    const permState = getOrCreateConversationPermissionModeStateRef(
      conversationRuntime.listener,
      agentId,
      conversationId,
    );
    if (permState.mode === "unrestricted") {
      permState.mode = "standard";
      persistPermissionModeMapForRuntime(conversationRuntime.listener);
    }
    if (cleared || lowerGoalArg === "disable") {
      return lowerGoalArg === "disable"
        ? "Goal disabled; goal tools removed for this conversation."
        : "Goal cleared";
    }
    return "No goal to clear. This conversation does not currently have a goal.";
  }

  // /goal pause, /goal resume, /goal complete
  if (
    lowerGoalArg === "pause" ||
    lowerGoalArg === "resume" ||
    lowerGoalArg === "complete"
  ) {
    const status = lowerGoalArg === "resume" ? "active" : lowerGoalArg;
    const goal = settingsManager.updateConversationGoalStatus(
      conversationId,
      status as "active" | "paused" | "complete",
    );
    if (!goal) {
      return `${GOAL_USAGE}\nThe session must have a goal before you can ${lowerGoalArg} it.`;
    }

    const permState = getOrCreateConversationPermissionModeStateRef(
      conversationRuntime.listener,
      agentId,
      conversationId,
    );

    if (lowerGoalArg === "pause" || lowerGoalArg === "complete") {
      if (ralphMode.getState().mode === "goal") {
        ralphMode.deactivate();
      }
      if (permState.mode === "unrestricted") {
        permState.mode = "standard";
        persistPermissionModeMapForRuntime(conversationRuntime.listener);
      }
    } else if (lowerGoalArg === "resume") {
      settingsManager.setConversationGoalToolsEnabled(conversationId, true);
      ralphMode.activateGoal(goal.objective, 0, true);
      permState.mode = "unrestricted";
      persistPermissionModeMapForRuntime(conversationRuntime.listener);

      // Send continuation prompt through the turn pipeline
      const goalState = ralphMode.getState();
      const storedGoal = settingsManager.getConversationGoal(conversationId);
      const liveActiveSeconds =
        storedGoal?.activeStartedAt && storedGoal.status === "active"
          ? Math.max(
              0,
              Math.floor(
                (Date.now() - Date.parse(storedGoal.activeStartedAt)) / 1000,
              ),
            )
          : 0;
      const systemMsg = buildGoalContinuationPrompt({
        objective: goalState.originalPrompt,
        status: "active",
        tokensUsed: storedGoal?.tokensUsed ?? 0,
        tokenBudget: storedGoal?.tokenBudget ?? goalState.tokenBudget,
        timeUsedSeconds:
          (storedGoal?.activeTimeSeconds ?? 0) + liveActiveSeconds,
      });

      await handleIncomingMessage(
        {
          type: "message",
          agentId,
          conversationId,
          messages: [
            {
              type: "message",
              role: "user",
              content: [{ type: "text", text: systemMsg }],
            },
          ],
        },
        socket,
        conversationRuntime,
        opts.onStatusChange,
        opts.connectionId,
      );
    }

    return `Goal ${goalStatusLabel(goal.status)}\n${formatGoalSummary(goal)}`;
  }

  // /goal <objective> — set a new goal
  const parsedGoal = parseGoalArgs(objective);
  if (parsedGoal.error) {
    return `${parsedGoal.error}\n${GOAL_USAGE}\n${GOAL_USAGE_HINT}`;
  }

  const validationError = validateGoalObjective(parsedGoal.objective);
  if (validationError) {
    return `${validationError}\n${GOAL_USAGE}\n${GOAL_USAGE_HINT}`;
  }

  const previousGoal = settingsManager.getConversationGoal(conversationId);
  if (previousGoal && !parsedGoal.replace) {
    return `A goal already exists. Run /goal --replace ${parsedGoal.objective} to replace it, or /goal clear first.`;
  }

  settingsManager.setConversationGoalToolsEnabled(conversationId, true);
  const goal = settingsManager.setConversationGoal(
    conversationId,
    parsedGoal.objective,
    conversationRuntime.activeWorkingDirectory ?? process.cwd(),
    parsedGoal.tokenBudget,
    true,
  );
  ralphMode.activateGoal(parsedGoal.objective, 0, true, parsedGoal.tokenBudget);

  const permState = getOrCreateConversationPermissionModeStateRef(
    conversationRuntime.listener,
    agentId,
    conversationId,
  );
  permState.mode = "unrestricted";
  persistPermissionModeMapForRuntime(conversationRuntime.listener);

  const replaced = previousGoal ? " replaced" : " active";
  const resultPrefix = `Goal${replaced} (iter 1/∞)\n${formatGoalSummary(goal)}`;

  // Send initial goal continuation prompt through the turn pipeline
  const goalState = ralphMode.getState();
  const storedGoal = settingsManager.getConversationGoal(conversationId);
  const liveActiveSeconds =
    storedGoal?.activeStartedAt && storedGoal.status === "active"
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - Date.parse(storedGoal.activeStartedAt)) / 1000,
          ),
        )
      : 0;
  const systemMsg = buildGoalContinuationPrompt({
    objective: goalState.originalPrompt,
    status: "active",
    tokensUsed: storedGoal?.tokensUsed ?? 0,
    tokenBudget: storedGoal?.tokenBudget ?? goalState.tokenBudget,
    timeUsedSeconds: (storedGoal?.activeTimeSeconds ?? 0) + liveActiveSeconds,
  });

  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: systemMsg }],
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return resultPrefix;
}

/** /set-max-context — Set or reset the active scope's max context window. */
async function handleSetMaxContextCommand(
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  const agentId = conversationRuntime.agentId;
  if (!agentId) {
    throw new Error("No agent ID available for /set-max-context command");
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
