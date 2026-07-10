import type { StopReasonType } from "@/types/protocol_v2";
import {
  emitInterruptedStatusDelta,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { TurnFinishTransition, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

export function finishListenerTurn(
  runtime: ConversationRuntime,
  lease: TurnLease,
  options: {
    stopReason: StopReasonType;
    socket?: ListenerTransport;
    runId?: string | null;
    agentId?: string | null;
    conversationId: string;
  },
): TurnFinishTransition {
  const transition = runtime.turnLifecycle.finish(lease, options.stopReason);
  if (!transition.finished) {
    return transition;
  }

  // Explicit abort projects the interrupted state when it moves the lease to
  // cancelling. Only server-originated cancellation reaches finish from active.
  if (
    options.stopReason === "cancelled" &&
    transition.previousKind === "active" &&
    options.socket
  ) {
    emitInterruptedStatusDelta(options.socket, runtime, {
      runId: options.runId ?? transition.runId,
      agentId: options.agentId,
      conversationId: options.conversationId,
    });
  }

  if (transition.previousKind === "active") {
    emitRuntimeStateUpdates(runtime, {
      agent_id: options.agentId ?? null,
      conversation_id: options.conversationId,
    });
  }
  return transition;
}
