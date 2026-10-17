import {
  retireMcpOriginatorTokenOnTerminal,
  retireMcpOriginatorTokensOnOriginSwap,
} from "@/agent/mcp-originator-tokens";
import type { createBuffers } from "@/cli/helpers/accumulator";
import { rebindTurnToolContextMcpOriginator } from "@/tools/execution-context-mcp-originator";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import type {
  RecoveryAuthorityStore,
  RecoveryEvidenceWriter,
} from "./recovery-evidence";
import {
  claimPendingTeleportAtBoundary,
  finishClaimedTeleport,
} from "./teleport";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import {
  checkpointTurnInputOwnership,
  type createTurnDurabilityOwnership,
} from "./turn-durability-ownership";
import type { TurnLease } from "./turn-lifecycle";
import { buildTurnUsage, finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime, IncomingMessage } from "./types";

type OriginCarrying = { mcpOriginatorSuperRunId?: string };

/**
 * Apply an origin swap when a parked turn consumes a queued turn from
 * another super run (or an unattributed one): retire both runs' held
 * originator tokens, then rebind the continuation's live (park-frozen) tool
 * context to the consumed turn's origin. The rebind is what makes the swap
 * a stable boundary — without it a late redelivery repopulating the parked
 * run's deleted key would be picked up by the very next tool call, since
 * per-call token lookups read the frozen context (evil-shub r4300657672).
 */
export function applyTurnOriginSwap(
  parkedInput: OriginCarrying,
  consumedTurn: OriginCarrying,
  turnToolContextId: string | null,
): void {
  retireMcpOriginatorTokensOnOriginSwap(
    parkedInput.mcpOriginatorSuperRunId,
    consumedTurn.mcpOriginatorSuperRunId,
  );
  rebindTurnToolContextMcpOriginator(
    turnToolContextId,
    consumedTurn.mcpOriginatorSuperRunId,
  );
}

/**
 * Build the onConsumeQueuedTurn callback for a parked turn: apply the origin
 * swap first, then record the consumed input and checkpoint ownership. The
 * factory lives here (not inline in turn.ts) so the swap cannot drift from
 * the durability checkpoint it must precede — and so turn.ts stays under
 * the source-size cap.
 */
export function createQueuedTurnConsumer(params: {
  parkedInput: OriginCarrying;
  turnToolContextId: string | null;
  runtime: ConversationRuntime;
  ownership: ReturnType<typeof createTurnDurabilityOwnership>;
  interruptedRevisionRef: { current: string | undefined };
  recoveryLineageId?: string;
  recoveryEvidenceWriter?: RecoveryEvidenceWriter;
}): (queuedTurn: IncomingMessage) => Promise<void> {
  return async (queuedTurn) => {
    applyTurnOriginSwap(
      params.parkedInput,
      queuedTurn,
      params.turnToolContextId,
    );
    params.ownership.recordInput(queuedTurn);
    params.interruptedRevisionRef.current = await checkpointTurnInputOwnership(
      params.runtime,
      params.ownership,
      params.interruptedRevisionRef.current,
      queuedTurn.actingUserId,
      params.recoveryLineageId,
      params.recoveryEvidenceWriter,
    );
  };
}

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
  recoveryAuthorityStore?: RecoveryAuthorityStore;
  /**
   * Super run owning this turn, when the relay delivered one. Its held MCP
   * originator token is dropped the moment the turn reaches a terminal state.
   */
  mcpOriginatorSuperRunId?: string;
}) {
  const recoveryLineageId = params.recoveryLineageId;
  if (recoveryLineageId && !params.recoveryAuthorityStore) {
    throw new Error(
      "Recovered finalizer requires its recovery authority store",
    );
  }
  const recoveryAuthorityStore =
    params.recoveryAuthorityStore ?? createInterruptedTurnStore();
  let finalized = false;
  const noteFinalization = (
    transition: ReturnType<typeof finishListenerTurn>,
  ) => {
    finalized ||= transition.finished;
    return transition;
  };
  const commitTurn = (options: Parameters<typeof finishListenerTurn>[2]) => {
    const transition = noteFinalization(
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
                recoveryAuthorityStore.readRecoverySnapshot(
                  params.runtime.agentId ?? "",
                  params.runtime.conversationId,
                  recoveryLineageId,
                )?.revisionToken,
              readInterruptedRevision: () =>
                recoveryAuthorityStore.readRecoverySnapshot(
                  params.runtime.agentId ?? "",
                  params.runtime.conversationId,
                  recoveryLineageId,
                )?.record.revision,
              recoveryAuthorityGuard: recoveryAuthorityStore,
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
    // Terminal run states (success/error/cancel) retire the run's held MCP
    // originator token. Rejected/duplicate commits leave the store alone.
    if (transition.finished && params.mcpOriginatorSuperRunId) {
      retireMcpOriginatorTokenOnTerminal(params.mcpOriginatorSuperRunId);
    }
    return transition;
  };
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
