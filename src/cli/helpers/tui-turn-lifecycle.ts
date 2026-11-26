export function settleTuiInterrupt(args: {
  userCancelledRef: { current: boolean };
  setInterruptRequested: (value: boolean) => void;
  queueLength: number;
  bumpDequeueEpoch: () => void;
  forceRelease?: {
    abortControllerRef: { current: AbortController | null };
    processingConversationRef: { current: number };
    conversationGenerationRef: { current: number };
    releasedGenerationRef: { current: number | null };
  };
}): void {
  if (args.forceRelease) {
    args.forceRelease.abortControllerRef.current = null;
    args.forceRelease.processingConversationRef.current = 0;
    args.forceRelease.conversationGenerationRef.current += 1;
    args.forceRelease.releasedGenerationRef.current =
      args.forceRelease.conversationGenerationRef.current;
  }
  args.userCancelledRef.current = false;
  args.setInterruptRequested(false);
  if (args.queueLength > 0) {
    args.bumpDequeueEpoch();
  }
}

export type TuiTurnFinishArgs = {
  isStale: boolean;
  turnAbortController: AbortController | null;
  turnGeneration: number;
  releasedGenerationRef?: { current: number | null };
  abortControllerRef: { current: AbortController | null };
  processingConversationRef: { current: number };
  staleTurnUnwindingRef?: { current: boolean };
  userCancelledRef: { current: boolean };
  setInterruptRequested: (value: boolean) => void;
  queueLength: () => number;
  bumpDequeueEpoch: () => void;
};

export function finishTuiTurn(args: TuiTurnFinishArgs): void {
  const ownsTurn = args.abortControllerRef.current === args.turnAbortController;
  const wasForceReleased =
    args.releasedGenerationRef?.current !== null &&
    args.releasedGenerationRef?.current !== undefined &&
    args.turnGeneration < args.releasedGenerationRef.current;
  if (ownsTurn) {
    args.abortControllerRef.current = null;
  }
  // A forced interrupt releases the ownership refs before this finally runs.
  // Do not let that late turn decrement a replacement turn's count.
  if (!ownsTurn && args.isStale && wasForceReleased) {
    if (args.staleTurnUnwindingRef) {
      args.staleTurnUnwindingRef.current = false;
    }
    return;
  }
  // Decrement BEFORE bumping the epoch: the dequeue effect can fire
  // synchronously (Ink legacy mode) and its defer gate checks === 0.
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
    if (args.staleTurnUnwindingRef) {
      args.staleTurnUnwindingRef.current = false;
    }
    settleTuiInterrupt({
      userCancelledRef: args.userCancelledRef,
      setInterruptRequested: args.setInterruptRequested,
      queueLength: args.queueLength(),
      bumpDequeueEpoch: args.bumpDequeueEpoch,
    });
  }
}
