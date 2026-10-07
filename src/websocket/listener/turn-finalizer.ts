import type { createBuffers } from "@/cli/helpers/accumulator";
import {
  readInterruptedTurn,
  readInterruptedTurnAuthorityRevision,
} from "./interrupted-turn-read";
import {
  claimPendingTeleportAtBoundary,
  finishClaimedTeleport,
} from "./teleport";
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
  interruptedRevisionRef?: { current: string | undefined };
  /** Recovery keeps execution evidence until its remote claim completion is ACKed. */
  deferInterruptedCleanup?: boolean;
  recoveryLineageId?: string;
  recoveryTerminalRevision?: string;
}) {
  const recoveryLineageId = params.recoveryLineageId;
  let finalized = false;
  const noteFinalization = (
    transition: ReturnType<typeof finishListenerTurn>,
  ) => {
    finalized ||= transition.finished;
    return transition;
  };
  const commitTurn = (options: Parameters<typeof finishListenerTurn>[2]) =>
    noteFinalization(
      finishListenerTurn(params.runtime, params.turnLease, {
        ...options,
        socket: options.socket ?? params.socket,
        turnId: params.ownership.terminalTurnId,
        terminalConsumerIds: params.ownership.terminalConsumerIds,
        durableInputIdentities: params.ownership.durableInputIdentities,
        expectedInterruptedRevision:
          options.expectedInterruptedRevision ??
          params.recoveryTerminalRevision ??
          params.interruptedRevisionRef?.current,
        ...(recoveryLineageId
          ? {
              persistTerminalWithoutConsumers:
                options.persistTerminalWithoutConsumers ?? true,
              expectedInterruptedAuthorityRevision:
                params.interruptedRevisionRef?.current,
              recoveryLineageId,
              readInterruptedAuthorityRevision: () =>
                readInterruptedTurnAuthorityRevision(
                  params.runtime,
                  recoveryLineageId,
                ),
              readInterruptedRevision: () =>
                readInterruptedTurn(params.runtime, recoveryLineageId)
                  ?.revision,
            }
          : {}),
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
  const finishTurn = (options: Parameters<typeof finishListenerTurn>[2]) => {
    const pending = params.agentId
      ? (claimPendingTeleportAtBoundary({
          listener: params.runtime.listener,
          agentId: params.agentId,
          conversationId: params.conversationId,
          activeTurn: true,
        }) ??
        claimPendingTeleportAtBoundary({
          listener: params.runtime.listener,
          agentId: params.agentId,
          conversationId: params.conversationId,
          activeTurn: false,
          drainedOnly: true,
        }))
      : null;
    return pending
      ? finishClaimedTeleport(
          params.runtime,
          pending,
          (boundaryOptions) => commitTurn({ ...options, ...boundaryOptions }),
          {
            stopReason: options.stopReason,
            canCommit: params.terminalCommitGuard,
            expectedInterruptedRevision: params.interruptedRevisionRef?.current,
          },
        )
      : commitTurn(options);
  };
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
    /** Commit a teleport already claimed by the caller without claiming it twice. */
    finishClaimedTurn: commitTurn,
    noteFinalization,
    get finalized() {
      return finalized;
    },
  };
}
