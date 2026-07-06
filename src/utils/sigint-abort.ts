// Bridges SIGINT delivery to AbortSignal-based cancellation.
//
// Headless one-shot mode has no interactive input loop, so without this
// wiring a SIGINT never cancels the in-flight turn: other SIGINT listeners
// (e.g. telemetry's bounded drain) keep the process alive while the turn
// continues consuming provider tool calls and executing their side effects.

interface SigintSource {
  once(event: "SIGINT", listener: () => void): unknown;
  removeListener(event: "SIGINT", listener: () => void): unknown;
}

export interface SigintAbort {
  signal: AbortSignal;
  dispose: () => void;
}

export function createSigintAbortController(
  proc: SigintSource = process,
): SigintAbort {
  const controller = new AbortController();
  const onSigint = () => {
    controller.abort();
  };
  proc.once("SIGINT", onSigint);
  return {
    signal: controller.signal,
    dispose: () => {
      proc.removeListener("SIGINT", onSigint);
    },
  };
}
