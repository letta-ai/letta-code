export const WORKER_STALL_INTERVAL_MS = 15 * 60 * 1000;

export function watchWorkerSilence(
  signal: AbortSignal,
  notify: (summary: string, result: string) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEvent: string | undefined;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      schedule();
      notify(
        "has produced no output for at least 15 minutes",
        `${lastEvent ?? "No worker events received yet."} The worker may be stuck in a long command. Check it, and stop and replace it if it doesn't respond.`,
      );
    }, WORKER_STALL_INTERVAL_MS);
    timer.unref();
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener("abort", stop);
  };
  if (!signal.aborted) {
    signal.addEventListener("abort", stop, { once: true });
    schedule();
  }
  return {
    record(at: string, summary: string) {
      if (timer === undefined) return;
      lastEvent = `Last event at ${at}: ${summary}.`;
      schedule();
    },
    stop,
  };
}
