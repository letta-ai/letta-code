import { APIError } from "@letta-ai/letta-client/core/error";
import {
  extractConflictDetail,
  getRetryDelayMs,
  shouldRetryPreStreamTransientError,
} from "@/agent/turn-recovery-policy";
import { LLM_API_ERROR_MAX_RETRIES } from "./constants";

/** Retry only reads: replaying recovery itself could repeat tool side effects. */
export async function retryApprovalRecoveryRead<T>(
  read: () => Promise<T>,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertCurrent();
    try {
      const result = await read();
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      const detail = extractConflictDetail(error);
      if (
        attempt >= LLM_API_ERROR_MAX_RETRIES ||
        !shouldRetryPreStreamTransientError({
          status: error instanceof APIError ? error.status : undefined,
          detail,
        })
      )
        throw error;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(
          done,
          getRetryDelayMs({
            category: "transient_provider",
            attempt: attempt + 1,
            detail,
          }),
        );
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
}
