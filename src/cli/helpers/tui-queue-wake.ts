/**
 * TUI dequeue is a React effect keyed on `dequeueEpoch` plus busy-state.
 * Interrupt handling mutates `userCancelledRef` — a ref change does not
 * re-run that effect. After the cancel guard drops, bump the epoch so a
 * queued Monitor notification (or user message) can start the next turn.
 *
 * This is the TUI analogue of the listener's cancelling → idle handoff,
 * which calls scheduleQueuePump once the lifecycle is idle.
 */
export function settleTuiInterruptQueueGuard(args: {
  userCancelledRef: { current: boolean };
  queueLength: number;
  bumpDequeueEpoch: () => void;
}): void {
  args.userCancelledRef.current = false;
  if (args.queueLength > 0) {
    args.bumpDequeueEpoch();
  }
}
