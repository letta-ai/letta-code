import type { createBuffers } from "@/cli/helpers/accumulator";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import type { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import type { TurnLease } from "./turn-lifecycle";
import { buildTurnUsage, finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime } from "./types";

export function createTurnFinalizer(params: {
  runtime: ConversationRuntime;
  turnLease: TurnLease;
  socket: ListenerTransport;
  ownership: ReturnType<typeof createTurnDurabilityOwnership>;
  turnCorrelation: TurnCorrelation;
  buffers: ReturnType<typeof createBuffers>;
  agentId: string | null;
  conversationId: string;
  terminalCommitGuard?: () => boolean;
  /** Recovery keeps execution evidence until its remote claim completion is ACKed. */
  deferInterruptedCleanup?: boolean;
}) {
  let finalized = false;
  const noteFinalization = (
    transition: ReturnType<typeof finishListenerTurn>,
  ) => {
    finalized ||= transition.finished;
    return transition;
  };
  const finishTurn = (options: Parameters<typeof finishListenerTurn>[2]) =>
    noteFinalization(
      finishListenerTurn(params.runtime, params.turnLease, {
        ...options,
        socket: options.socket ?? params.socket,
        turnId: params.ownership.terminalTurnId,
        terminalConsumerIds: params.ownership.terminalConsumerIds,
        durableInputIdentities: params.ownership.durableInputIdentities,
        ...(params.terminalCommitGuard
          ? { canCommit: params.terminalCommitGuard }
          : {}),
        ...(params.deferInterruptedCleanup && !options.forgetWork
          ? { forgetWork: () => {} }
          : {}),
        ...(options.errorNotice
          ? {
              errorNotice: {
                ...options.errorNotice,
                clientMessageIds: params.turnCorrelation.clientMessageIds,
              },
            }
          : {}),
        ...(params.runtime.executionSettings
          ? { usage: buildTurnUsage(params.buffers.usage) }
          : {}),
      }),
    );
  const finishIfInterrupted = (runId?: string | null): boolean => {
    if (
      !params.turnLease.signal.aborted &&
      params.runtime.turnLifecycle.isCurrent(params.turnLease) &&
      params.terminalCommitGuard?.() !== false
    ) {
      return false;
    }
    finishTurn({
      stopReason: "cancelled",
      socket: params.socket,
      runId,
      agentId: params.agentId,
      conversationId: params.conversationId,
    });
    return true;
  };
  return {
    finishIfInterrupted,
    finishTurn,
    noteFinalization,
    get finalized() {
      return finalized;
    },
  };
}
