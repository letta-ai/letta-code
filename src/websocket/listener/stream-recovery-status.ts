import { emitStatusDelta } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime } from "./types";

const TERMINAL_EOF_WARNING =
  "Stream did not close after completing, continued without waiting";
const STREAM_STALL_WARNING =
  "Stream went silent, reconnecting to recover the missed tail";

export function emitStreamRecoveryStatusDeltas(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  params: {
    terminalEofGuardFired?: boolean;
    stallReconcilerFired?: boolean;
    runId?: string | null;
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  const messages = [
    ...(params.terminalEofGuardFired ? [TERMINAL_EOF_WARNING] : []),
    ...(params.stallReconcilerFired ? [STREAM_STALL_WARNING] : []),
  ];

  for (const message of messages) {
    emitStatusDelta(socket, runtime, {
      message,
      level: "warning",
      runId: params.runId,
      agentId: params.agentId,
      conversationId: params.conversationId,
    });
  }
}
