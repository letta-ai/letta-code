import type { QueueBlockedReason } from "../../queue/queueRuntime";

export type ListenerQueueGatingConditions = {
  isProcessing: boolean;
  pendingApprovalsLen: number;
  cancelRequested: boolean;
  isRecoveringApprovals: boolean;
};

export function getListenerBlockedReason(
  c: ListenerQueueGatingConditions,
): QueueBlockedReason | null {
  if (c.pendingApprovalsLen > 0) return "pending_approvals";
  if (c.cancelRequested) return "interrupt_in_progress";
  if (c.isRecoveringApprovals) return "runtime_busy";
  if (c.isProcessing) return "runtime_busy";
  return null;
}
