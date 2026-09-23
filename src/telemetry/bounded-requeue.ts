/**
 * Re-queue events that failed to flush ahead of pending events, dropping the
 * oldest events when the queue would exceed `maxQueued`. Bounds memory growth
 * while the telemetry endpoint is unreachable. Returns the number dropped.
 */
export function requeueFailedEvents<T>(
  queue: T[],
  failed: readonly T[],
  maxQueued: number,
): number {
  queue.unshift(...failed);
  const excess = queue.length - maxQueued;
  if (excess <= 0) {
    return 0;
  }
  queue.splice(0, excess);
  if (process.env.LETTA_DEBUG) {
    console.error(
      `Telemetry: dropped ${excess} oldest queued event(s); failed-flush re-queue capped at ${maxQueued}`,
    );
  }
  return excess;
}
