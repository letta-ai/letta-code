import type {
  createInterruptedTurnStore,
  InterruptedTurnRecord,
} from "./interrupted-turn-record";

export type InterruptedTurnStore = ReturnType<
  typeof createInterruptedTurnStore
>;
type RecoveryClaimCompletionStore = Pick<
  InterruptedTurnStore,
  "markRecoveryClaimCompletionPending" | "retireRecoveryClaimCompletion"
>;

/**
 * Retire an acknowledged recovery claim without deleting evidence written by a
 * different lineage while the remote completion request was in flight.
 */
export type RecoveryClaimRetirement =
  | "removed"
  | "preserved"
  | "stale"
  | "failed";

export function retireAcknowledgedRecoveryClaim(
  store: RecoveryClaimCompletionStore,
  params: {
    agentId: string;
    conversationId: string;
    lineageId: string;
    pendingRevision: string;
  },
): RecoveryClaimRetirement {
  try {
    return store.retireRecoveryClaimCompletion(params);
  } catch {
    return "failed";
  }
}

/** Durably move one exact running recovery lineage to completion-pending. */
export function markRecoveryClaimCompletionPending(
  store: RecoveryClaimCompletionStore,
  record: InterruptedTurnRecord,
  observedRevision: string | undefined = record.revision,
): InterruptedTurnRecord | null {
  const marker = record.recoveryClaimCompletion;
  if (!record.revision || !marker || marker.state !== "running") return null;
  try {
    if (!observedRevision) return null;
    return store.markRecoveryClaimCompletionPending({
      agentId: record.agentId,
      conversationId: record.conversationId,
      lineageId: marker.lineageId,
      expectedRevision: observedRevision,
    });
  } catch {
    return null;
  }
}
