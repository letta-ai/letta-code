type Interrupt = "SIGINT" | "SIGTERM";

interface SignalSource {
  removeListener(event: Interrupt, listener: () => void): unknown;
  once(event: Interrupt, listener: () => void): unknown;
}

export function createProcessAbortSignal(
  events: readonly Interrupt[],
  proc: SignalSource = process,
) {
  const controller = new AbortController();
  const listeners = events.map((event) => {
    const listener = () =>
      controller.abort(new DOMException(event, "AbortError"));
    proc.once(event, listener);
    return { event, listener };
  });
  return {
    signal: controller.signal,
    dispose() {
      for (const { event, listener } of listeners)
        proc.removeListener(event, listener);
    },
  };
}

export function createSigintAbortSignal(
  proc: SignalSource = process,
): AbortSignal {
  return createProcessAbortSignal(["SIGINT"], proc).signal;
}
