import type {
  createInterruptedTurnStore,
  InterruptedTurnRecord,
} from "./interrupted-turn-record";

export type InterruptedTurnStore = ReturnType<
  typeof createInterruptedTurnStore
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
  store: InterruptedTurnStore,
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
  store: InterruptedTurnStore,
  record: InterruptedTurnRecord,
): InterruptedTurnRecord | null {
  const marker = record.recoveryClaimCompletion;
  if (!record.revision || !marker || marker.state !== "running") return null;
  try {
    return store.markRecoveryClaimCompletionPending({
      agentId: record.agentId,
      conversationId: record.conversationId,
      lineageId: marker.lineageId,
    });
  } catch {
    return null;
  }
}
