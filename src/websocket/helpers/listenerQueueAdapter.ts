import type { QueueBlockedReason } from "../../queue/queueRuntime";
import type { LoopStatus } from "../../types/protocol_v2";

export type ListenerQueueGatingConditions = {
  loopStatus: LoopStatus;
  isProcessing: boolean;
  pendingApprovalsLen: number;
  cancelRequested: boolean;
  isRecoveringApprovals: boolean;
};

export function getListenerBlockedReason(
  c: ListenerQueueGatingConditions,
): QueueBlockedReason | null {
  if (
    c.cancelRequested &&
    (c.isProcessing ||
      c.isRecoveringApprovals ||
      c.loopStatus !== "WAITING_ON_INPUT")
  ) {
    return "interrupt_in_progress";
  }
  if (c.pendingApprovalsLen > 0) return "pending_approvals";
  if (c.isRecoveringApprovals) return "runtime_busy";
  if (c.loopStatus === "WAITING_ON_APPROVAL") return "pending_approvals";
  if (c.loopStatus === "EXECUTING_COMMAND") return "command_running";
  if (
    c.loopStatus === "SENDING_API_REQUEST" ||
    c.loopStatus === "RETRYING_API_REQUEST" ||
    c.loopStatus === "WAITING_FOR_API_RESPONSE" ||
    c.loopStatus === "PROCESSING_API_RESPONSE" ||
    c.loopStatus === "EXECUTING_CLIENT_SIDE_TOOL"
  ) {
    return "streaming";
  }
  if (c.isProcessing) return "runtime_busy";
  return null;
}
