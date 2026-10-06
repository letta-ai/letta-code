import { debugWarn } from "@/utils/debug";
import type { ConversationRuntime } from "./types";

const scheduledRetries = new WeakSet<ConversationRuntime>();
const RETRY_DELAY_MS = 250;

/** Coalesce claim-loss recovery after the stale lease has unwound to idle. */
export function scheduleRecoveredApprovalRetry(
  runtime: ConversationRuntime,
  retry: () => Promise<unknown>,
): void {
  if (scheduledRetries.has(runtime)) return;
  scheduledRetries.add(runtime);
  setImmediate(() => {
    scheduledRetries.delete(runtime);
    if (runtime.listener.intentionallyClosed) return;
    void retry()
      .then((handled) => {
        if (
          handled === false &&
          runtime.recoveredApprovalState &&
          !runtime.listener.intentionallyClosed
        ) {
          const timer = setTimeout(
            () => scheduleRecoveredApprovalRetry(runtime, retry),
            RETRY_DELAY_MS,
          );
          timer.unref?.();
        }
      })
      .catch((error) => {
        debugWarn("recovery", "Recovered approval retry failed", error);
        if (
          runtime.recoveredApprovalState &&
          !runtime.listener.intentionallyClosed
        ) {
          const timer = setTimeout(
            () => scheduleRecoveredApprovalRetry(runtime, retry),
            RETRY_DELAY_MS,
          );
          timer.unref?.();
        }
      });
  });
}
