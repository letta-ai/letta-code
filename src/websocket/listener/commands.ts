import type WebSocket from "ws";
import { getClient } from "../../agent/client";
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
import {
  clearConversationRuntimeState,
  emitListenerStatus,
} from "./runtime";
import type { ConversationRuntime, StartListenerOptions } from "./types";

const ISOLATED_BLOCK_LABELS = ["human", "persona"];

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

  const input = `/${command.command_id}`;

  // Emit slash_command_start
  const startDelta: SlashCommandStartMessage = {
    ...createLifecycleMessageBase("slash_command_start"),
    command_id: command.command_id,
    input,
  };
  emitCanonicalMessageDelta(socket, conversationRuntime, startDelta as StreamDelta, scope);

  try {
    let output: string;

    switch (command.command_id) {
      case "clear":
        output = await handleClearCommand(socket, conversationRuntime, opts);
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
    const errorMessage =
      error instanceof Error ? error.message : String(error);
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
  fields: Pick<SlashCommandEndMessage, "command_id" | "input" | "output" | "success">,
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
  socket: WebSocket,
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
