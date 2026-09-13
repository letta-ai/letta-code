import type { QueueBlockedReason } from "@/queue/queue-runtime";
import type { TurnLifecycleSnapshot } from "@/websocket/listener/turn-lifecycle";

export function getListenerBlockedReason(
  lifecycle: TurnLifecycleSnapshot,
  pendingApprovalsLen: number,
): QueueBlockedReason | null {
  if (lifecycle.kind === "cancelling") {
    return "interrupt_in_progress";
  }
  if (pendingApprovalsLen > 0) {
    return "pending_approvals";
  }
  if (lifecycle.kind === "command") {
    return "command_running";
  }
  if (lifecycle.kind === "active") {
    return lifecycle.loopStatus === "WAITING_ON_APPROVAL"
      ? "pending_approvals"
      : "streaming";
  }
  return null;
}
