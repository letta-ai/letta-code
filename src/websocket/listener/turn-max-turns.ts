import type { createBuffers } from "@/cli/helpers/accumulator";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { StopReasonType } from "@/types/protocol_v2";
import { populateInterruptQueue } from "./interrupts";
import type { ListenerTransport } from "./transport";
import type { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime } from "./types";

/**
 * Ends the turn with max_steps once the runtime's max_turns cap is reached.
 * A pending approval at the cap is not executed: its tool calls are queued as
 * denials (sent ahead of the next turn's input) and the turn ends with max_steps.
 * Returns true when the turn was finished.
 */
export function finishTurnIfMaxTurnsReached(params: {
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  buffers: ReturnType<typeof createBuffers>;
  stopReason: StopReasonType;
  approvals: ApprovalRequest[];
  fallbackError: string | null;
  runId: string | null | undefined;
  agentId: string | null;
  conversationId: string;
  finishTurn: (options: Parameters<typeof finishListenerTurn>[2]) => unknown;
}): boolean {
  const { runtime, buffers, stopReason, agentId, conversationId } = params;
  const maxTurns = runtime.executionSettings?.max_turns;
  if (
    maxTurns === undefined ||
    buffers.usage.stepCount < maxTurns ||
    (stopReason === "error" && params.fallbackError)
  ) {
    return false;
  }
  const message = `Maximum turns limit reached (${buffers.usage.stepCount}/${maxTurns} steps)`;
  if (stopReason === "requires_approval") {
    populateInterruptQueue(runtime, {
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: params.approvals.map((a) => a.toolCallId),
      agentId,
      conversationId,
      denialReason: message,
    });
  }
  params.finishTurn({
    stopReason: "max_steps",
    socket: params.socket,
    agentId,
    conversationId,
    errorNotice: { message, runId: params.runId },
  });
  return true;
}
