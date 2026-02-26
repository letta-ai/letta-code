/**
 * Helpers for the PRQ4 TUI QueueRuntime mirror.
 *
 * These are extracted as pure functions so they are independently unit-testable
 * without importing React or App.tsx.
 */

import type { QueueBlockedReason } from "../../types/protocol";

export type TuiQueueGatingConditions = {
  streaming: boolean;
  isExecutingTool: boolean;
  commandRunning: boolean;
  pendingApprovalsLen: number;
  queuedOverlayAction: boolean;
  anySelectorOpen: boolean;
  waitingForQueueCancel: boolean;
  userCancelled: boolean;
  abortControllerActive: boolean;
};

/**
 * Map the TUI dequeue gating conditions to a QueueBlockedReason.
 * Priority order matches the plan — first match wins.
 * Returns null when all conditions are clear (dequeue should proceed).
 */
export function getTuiBlockedReason(
  c: TuiQueueGatingConditions,
): QueueBlockedReason | null {
  if (c.waitingForQueueCancel || c.userCancelled)
    return "interrupt_in_progress";
  if (c.pendingApprovalsLen > 0) return "pending_approvals";
  if (c.queuedOverlayAction || c.anySelectorOpen) return "overlay_open";
  if (c.commandRunning) return "command_running";
  if (c.streaming || c.isExecutingTool || c.abortControllerActive)
    return "streaming";
  return null;
}
