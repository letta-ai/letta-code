import type { ApprovalResult } from "@/agent/approval-execution";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";

export function allRecordedResults(
  record: InterruptedTurnRecord,
): ApprovalResult[] {
  const merged = new Map(
    record.results.map((result) => [result.tool_call_id, result]),
  );
  for (const effect of record.settledRecoveryEffects ?? []) {
    merged.set(effect.result.tool_call_id, effect.result);
  }
  return [...merged.values()];
}

export function recordedToolResults(
  record: InterruptedTurnRecord,
  pendingToolCallIds: string[],
): ApprovalResult[] {
  const durableResults = allRecordedResults(record);
  return pendingToolCallIds.map(
    (id) =>
      durableResults.find((result) => result.tool_call_id === id) ?? {
        type: "approval",
        tool_call_id: id,
        approve: false,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      },
  );
}
