import type { ListenerTransport } from "./transport";
import type { TurnLease } from "./turn-lifecycle";
import { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime } from "./types";

type FinishTurnOptions = Parameters<typeof finishListenerTurn>[2];
type FinishTurnTransition = ReturnType<typeof finishListenerTurn>;

export function createTurnFinalizer(params: {
  runtime: ConversationRuntime;
  turnLease: TurnLease;
  socket: ListenerTransport;
  getTurnId: () => string;
  getAgentId: () => string | null;
  conversationId: string;
}): {
  noteFinalization: (transition: FinishTurnTransition) => FinishTurnTransition;
  finishTurn: (options: FinishTurnOptions) => FinishTurnTransition;
  finishIfInterrupted: (runId?: string | null) => boolean;
  wasFinalized: () => boolean;
} {
  let finalizedByThisInvocation = false;
  const noteFinalization = (transition: FinishTurnTransition) => {
    finalizedByThisInvocation ||= transition.finished;
    return transition;
  };
  const finishTurn = (options: FinishTurnOptions) =>
    noteFinalization(
      finishListenerTurn(params.runtime, params.turnLease, {
        ...options,
        socket: options.socket ?? params.socket,
        turnId: params.getTurnId(),
      }),
    );
  return {
    noteFinalization,
    finishTurn,
    finishIfInterrupted(runId) {
      if (
        !params.turnLease.signal.aborted &&
        params.runtime.turnLifecycle.isCurrent(params.turnLease)
      ) {
        return false;
      }
      finishTurn({
        stopReason: "cancelled",
        socket: params.socket,
        runId,
        agentId: params.getAgentId(),
        conversationId: params.conversationId,
      });
      return true;
    },
    wasFinalized: () => finalizedByThisInvocation,
  };
}
