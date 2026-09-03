/**
 * Settle a TUI interrupt: the `cancelling -> idle` boundary.
 *
 * The TUI mirrors the listener's turn lifecycle with refs instead of a state
 * machine. `userCancelledRef` plays the role of the listener's `cancelling`
 * state: it blocks the dequeue effect while an interrupted turn unwinds. The
 * owner of that turn (the `finally` block of processConversation) calls this
 * once the last in-flight call has finished, the same way the listener pumps
 * its queue when a lease completes `cancelling -> idle`.
 *
 * Clearing a ref does not re-run the dequeue effect, so the epoch is bumped
 * whenever work is still queued.
 */
export function settleTuiInterrupt(args: {
  userCancelledRef: { current: boolean };
  setInterruptRequested: (value: boolean) => void;
  queueLength: number;
  bumpDequeueEpoch: () => void;
}): void {
  args.userCancelledRef.current = false;
  args.setInterruptRequested(false);
  if (args.queueLength > 0) {
    args.bumpDequeueEpoch();
  }
}

export type TuiTurnFinishArgs = {
  /** True when an ESC interrupt bumped the generation past this turn's. */
  isStale: boolean;
  /** The controller this turn created, or null if it never got that far. */
  turnAbortController: AbortController | null;
  abortControllerRef: { current: AbortController | null };
  processingConversationRef: { current: number };
  userCancelledRef: { current: boolean };
  setInterruptRequested: (value: boolean) => void;
  queueLength: () => number;
  bumpDequeueEpoch: () => void;
};

/**
 * Finalize one processConversation call. TUI analogue of the listener's
 * finishListenerTurn(): clears only this turn's controller, decrements the
 * processing count, then either wakes the dequeue effect (normal completion)
 * or settles the interrupt (stale turn, `cancelling -> idle`) once the last
 * nested call has unwound. A stale turn unwinding late never clears the
 * controller of the turn that replaced it.
 */
export function finishTuiTurn(args: TuiTurnFinishArgs): void {
  if (args.abortControllerRef.current === args.turnAbortController) {
    args.abortControllerRef.current = null;
  }
  // Decrement BEFORE bumping the epoch: the dequeue effect can fire
  // synchronously (Ink legacy mode) and its defer gate checks === 0.
  args.processingConversationRef.current = Math.max(
    0,
    args.processingConversationRef.current - 1,
  );
  if (!args.isStale) {
    // The dequeue effect gates on abortControllerRef (a ref, not state), so
    // it needs an explicit re-trigger now that this turn is done.
    if (args.queueLength() > 0) {
      args.bumpDequeueEpoch();
    }
    return;
  }
  if (args.processingConversationRef.current === 0) {
    settleTuiInterrupt({
      userCancelledRef: args.userCancelledRef,
      setInterruptRequested: args.setInterruptRequested,
      queueLength: args.queueLength(),
      bumpDequeueEpoch: args.bumpDequeueEpoch,
    });
  }
}
