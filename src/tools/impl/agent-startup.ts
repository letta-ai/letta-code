/**
 * Agent startup gives up the foreground after the same 10s as Bash and
 * external tools. Work still pending then moves into the background task,
 * which reports the outcome as its completion notification.
 */
export const AGENT_STARTUP_YIELD_MS = 10_000;

/**
 * Remaining foreground budget for one launch, or null to wait for the outcome
 * (App Server callers need it in their response).
 */
export function createStartupBudget(
  yieldMs: number | null,
): () => number | null {
  if (yieldMs === null) return () => null;
  const deadline = Date.now() + yieldMs;
  // Startup waits treat 0 as "no deadline", so never return less than 1.
  return () => Math.max(1, deadline - Date.now());
}

/** Startup's result if it settles within the budget, else undefined. */
export async function settleWithinBudget<T>(
  startup: Promise<T>,
  budgetMs: number | null,
): Promise<T | undefined> {
  if (budgetMs === null) return startup;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    startup,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budgetMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Await startup moved into a task; stopping the task stops the wait at once. */
export function awaitDeferredStartup<T>(
  startup: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return startup;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Stopped before startup finished"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    startup
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
