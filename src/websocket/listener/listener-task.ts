import { trackBoundaryError } from "@/telemetry/error-reporting";
import { isDebugEnabled } from "@/utils/debug";

export function trackListenerError(
  errorType: string,
  error: unknown,
  context: string,
): void {
  trackBoundaryError({
    errorType,
    error,
    context,
  });
}

export function runDetachedListenerTask(
  commandName: string,
  task: () => Promise<void>,
): void {
  void task().catch((error) => {
    trackListenerError(
      `listener_${commandName}_failed`,
      error,
      `listener_${commandName}`,
    );
    if (isDebugEnabled())
      console.error(`[Listen] ${commandName} failed:`, error);
  });
}
