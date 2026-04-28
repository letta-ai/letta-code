import { createRelayedAbortController } from "./createRelayedAbortController";

const streamAbortRelayCleanupByStream = new WeakMap<object, () => void>();

function composeCleanups(first: () => void, second: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    first();
    second();
  };
}

export interface StreamAbortRelay {
  signal: AbortSignal;
  attach: (stream: object) => void;
  cleanup: () => void;
}

export function createStreamAbortRelay(
  parentSignal?: AbortSignal,
): StreamAbortRelay | null {
  if (!parentSignal) {
    return null;
  }

  const requestAbort = createRelayedAbortController(parentSignal);
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    requestAbort.cleanup();
  };

  return {
    signal: requestAbort.signal,
    attach(stream: object) {
      const existingCleanup = streamAbortRelayCleanupByStream.get(stream);
      streamAbortRelayCleanupByStream.set(
        stream,
        existingCleanup ? composeCleanups(existingCleanup, cleanup) : cleanup,
      );
    },
    cleanup,
  };
}

export function cleanupStreamAbortRelay(stream: object): void {
  const cleanup = streamAbortRelayCleanupByStream.get(stream);
  if (!cleanup) {
    return;
  }

  streamAbortRelayCleanupByStream.delete(stream);
  cleanup();
}
