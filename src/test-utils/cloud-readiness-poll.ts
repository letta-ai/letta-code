import { isRetryableCloudReadinessError } from "./cloud-readiness-retry";

/** A timeout from this fixture's own per-request signal, with its HTTP step. */
export class CloudRequestTimeoutError extends Error {
  constructor(step: string, cause: unknown) {
    super(`${step}: per-request timeout`, { cause });
  }
}

/** Read-only readiness probes share one deadline, including requests and waits. */
export async function pollCloudReadiness<T>(
  label: string,
  probe: (remainingMs: number) => Promise<T | undefined>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    wait?: (ms: number) => Promise<unknown>;
  } = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + (options.timeoutMs ?? 60_000);
  let lastError: unknown;
  while (now() < deadline) {
    try {
      const result = await probe(deadline - now());
      if (result !== undefined && now() < deadline) return result;
    } catch (error) {
      if (
        !(error instanceof CloudRequestTimeoutError) &&
        !isRetryableCloudReadinessError(error)
      )
        throw error;
      lastError = error;
    }
    await wait(Math.min(500, Math.max(0, deadline - now())));
  }
  throw new Error(
    `${label} timed out${lastError instanceof Error ? `; last transient error: ${lastError.message}` : ""}`,
    { cause: lastError },
  );
}
