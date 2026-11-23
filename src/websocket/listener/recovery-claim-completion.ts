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
