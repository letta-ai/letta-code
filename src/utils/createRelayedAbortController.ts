export interface RelayedAbortController {
  controller: AbortController;
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Create a per-request AbortController that relays aborts from a longer-lived
 * parent signal.
 *
 * Reusing the same long-lived signal across many streamed requests can cause
 * abort listeners from the underlying fetch/stream implementation to pile up on
 * the parent. Giving each request a fresh child signal keeps those listeners
 * scoped to the request instead.
 */
export function createRelayedAbortController(
  parentSignal?: AbortSignal,
): RelayedAbortController {
  const controller = new AbortController();

  if (!parentSignal) {
    return {
      controller,
      signal: controller.signal,
      cleanup: () => {},
    };
  }

  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
    return {
      controller,
      signal: controller.signal,
      cleanup: () => {},
    };
  }

  const relayAbort = () => {
    controller.abort(parentSignal.reason);
  };

  parentSignal.addEventListener("abort", relayAbort, { once: true });

  return {
    controller,
    signal: controller.signal,
    cleanup: () => {
      parentSignal.removeEventListener("abort", relayAbort);
    },
  };
}
