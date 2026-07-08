// Bridges SIGINT delivery to AbortSignal-based cancellation.

interface SigintSource {
  once(event: "SIGINT", listener: () => void): unknown;
}

export function createSigintAbortSignal(
  proc: SigintSource = process,
): AbortSignal {
  const controller = new AbortController();
  proc.once("SIGINT", () => {
    controller.abort();
  });
  return controller.signal;
}
