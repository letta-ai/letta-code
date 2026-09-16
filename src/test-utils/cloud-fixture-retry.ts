import { parseRetryAfterHeaderMs } from "@/agent/turn-recovery-policy";
import { isCloudApiShutdownRejection } from "@/utils/cloud-api-shutdown";

/** Retry only fixture requests the draining server explicitly did not accept. */
export async function createCloudFixture<T>(
  create: () => Promise<T>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await create();
    } catch (error) {
      if (!isCloudApiShutdownRejection(error) || attempt >= 3) throw error;
      const retryAfter =
        error.headers instanceof Headers
          ? parseRetryAfterHeaderMs(error.headers.get("Retry-After"))
          : null;
      const delayMs = retryAfter ?? 1000;
      if (delayMs > 10_000) throw error;
      await wait(delayMs);
    }
  }
}
