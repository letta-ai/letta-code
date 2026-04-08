import type WebSocket from "ws";
import { getClient } from "../../agent/client";
import { ISOLATED_BLOCK_LABELS } from "../../agent/memory";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { MIGRATE_PROMPT, REMEMBER_PROMPT } from "../../agent/promptAssets";
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
  "migrate",
  "remember",
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

      case "migrate":
        output = await handleMigrateCommand(socket, conversationRuntime, opts);
        break;

      case "remember":
        output = await handleRememberCommand(
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
 * /migrate — Migrate memory from Claude Code / Codex history.
 *
 * Sends the migrate prompt through the normal turn pipeline so the agent
 * detects history files, splits them, and launches history-analyzer subagents.
 */
async function handleMigrateCommand(
  socket: WebSocket,
  conversationRuntime: ConversationRuntime,
  opts: {
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<string> {
  const agentId = conversationRuntime.agentId;

  if (!agentId) {
    throw new Error("No agent ID available for /migrate command");
  }

  const migrateReminder = `${SYSTEM_REMINDER_OPEN}\n${MIGRATE_PROMPT}\n${SYSTEM_REMINDER_CLOSE}`;

  await handleIncomingMessage(
    {
      type: "message",
      agentId,
      conversationId: conversationRuntime.conversationId,
      messages: [
        {
          type: "message",
          role: "user",
          content: [{ type: "text", text: migrateReminder }],
        },
      ],
    },
    socket,
    conversationRuntime,
    opts.onStatusChange,
    opts.connectionId,
  );

  return "Memory migration completed";
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
