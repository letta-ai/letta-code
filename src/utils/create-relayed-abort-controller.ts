export interface RelayedAbortController {
  controller: AbortController;
  signal: AbortSignal;
  cleanup: () => void;
}

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
