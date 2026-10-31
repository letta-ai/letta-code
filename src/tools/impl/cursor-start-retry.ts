import { setTimeout } from "node:timers/promises";

export function isCursorModelRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^AI Model Not Found\s+Model name is not valid:/.test(error.message)
  );
}

// Retry only the provider's intermittent rejection of an otherwise valid ID.
// Callers must stop retries after tool execution or cancellation.
export async function retryCursorStart<T>(
  start: () => Promise<T>,
  canRetry: () => boolean,
  sleep: (ms: number) => Promise<unknown> = setTimeout,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      if (attempt >= 2 || !isCursorModelRejection(error) || !canRetry())
        throw error;
      await sleep(500 * (attempt + 1));
      if (!canRetry()) throw error;
    }
  }
}
