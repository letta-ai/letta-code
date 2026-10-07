import type { StopReasonType } from "@/types/protocol_v2";
import {
  emitLoopErrorNotice,
  getTranscriptLoopErrorMessage,
} from "./recoverable-notices";
import {
  claimPendingTeleportAtBoundary,
  finishClaimedTeleport,
} from "./teleport";
import type { ListenerTransport } from "./transport";
import type { TurnLease } from "./turn-lifecycle";
import { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime, InputIdentity } from "./types";

/** Apply identical teleport fencing to every recovered terminal outcome. */
export function createRecoveredTurnFinalizer(params: {
  runtime: ConversationRuntime;
  recoveryLease: TurnLease;
  recovered: {
    agentId: string;
    conversationId: string;
    interruptedRevision?: string;
    terminalConsumerIds?: readonly string[];
    durableInputIdentities?: readonly InputIdentity[];
  };
  getInterruptedRevision: () => string | undefined;
  canCommit: () => boolean;
}) {
  const commit = (options: Parameters<typeof finishListenerTurn>[2]) =>
    finishListenerTurn(params.runtime, params.recoveryLease, {
      ...options,
      terminalConsumerIds: params.recovered.terminalConsumerIds,
      durableInputIdentities: params.recovered.durableInputIdentities,
      expectedInterruptedRevision:
        options.expectedInterruptedRevision ?? params.getInterruptedRevision(),
      canCommit: params.canCommit,
    });

  return (options: Parameters<typeof finishListenerTurn>[2]) => {
    const pending =
      claimPendingTeleportAtBoundary({
        listener: params.runtime.listener,
        agentId: params.recovered.agentId,
        conversationId: params.recovered.conversationId,
        activeTurn: true,
      }) ??
      claimPendingTeleportAtBoundary({
        listener: params.runtime.listener,
        agentId: params.recovered.agentId,
        conversationId: params.recovered.conversationId,
        activeTurn: false,
        drainedOnly: true,
      });
    return pending
      ? finishClaimedTeleport(
          params.runtime,
          pending,
          (boundary) => commit({ ...options, ...boundary }),
          {
            stopReason: options.stopReason,
            canCommit: params.canCommit,
            expectedInterruptedRevision: params.getInterruptedRevision(),
          },
        )
      : commit(options);
  };
}

export function finalizeHandledRecoveryTurn(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  params: {
    drainResult: { stopReason?: string | null };
    agentId?: string | null;
    conversationId: string;
    turnId: string;
  },
  finalize: (
    options: Parameters<typeof finishListenerTurn>[2],
  ) => ReturnType<typeof finishListenerTurn>,
): ReturnType<typeof finishListenerTurn> {
  if (params.drainResult.stopReason === "end_turn") {
    return finalize({
      stopReason: "end_turn",
      socket,
      agentId: params.agentId,
      conversationId: params.conversationId,
      turnId: params.turnId,
    });
  }
  if (params.drainResult.stopReason === "cancelled") {
    return finalize({
      stopReason: "cancelled",
      socket,
      runId: runtime.activeRunId,
      agentId: params.agentId ?? undefined,
      conversationId: params.conversationId,
      turnId: params.turnId,
    });
  }
  const terminalStopReason =
    (params.drainResult.stopReason as StopReasonType) || "error";
  const noticeParams = {
    message: `Recovery continuation ended unexpectedly: ${terminalStopReason}`,
    agentId: params.agentId,
    conversationId: params.conversationId,
  };
  const transition = finalize({
    stopReason: terminalStopReason,
    socket,
    agentId: params.agentId,
    conversationId: params.conversationId,
    turnId: params.turnId,
    error: getTranscriptLoopErrorMessage(noticeParams),
  });
  if (!transition.finished) return transition;
  emitLoopErrorNotice(socket, runtime, {
    ...noticeParams,
    stopReason: terminalStopReason,
    isTerminal: true,
    runId: runtime.activeRunId || undefined,
  });
  return transition;
}
