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
  isStale: boolean;
  turnAbortController: AbortController | null;
  abortControllerRef: { current: AbortController | null };
  processingConversationRef: { current: number };
  userCancelledRef: { current: boolean };
  setInterruptRequested: (value: boolean) => void;
  queueLength: () => number;
  bumpDequeueEpoch: () => void;
};

export function finishTuiTurn(args: TuiTurnFinishArgs): void {
  if (args.abortControllerRef.current === args.turnAbortController) {
    args.abortControllerRef.current = null;
  }
  args.processingConversationRef.current = Math.max(
    0,
    args.processingConversationRef.current - 1,
  );
  if (!args.isStale) {
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
