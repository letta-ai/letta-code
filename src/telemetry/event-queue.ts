import { debugWarn } from "@/utils/debug";

/**
 * Maximum number of telemetry events held in the in-memory queue. Failed
 * flushes re-queue their events, so without a bound a session with an
 * unreachable endpoint grows the queue for the process lifetime.
 */
export const MAX_QUEUED_EVENTS = 2_000;

/** Minimum interval between queue-overflow debug log lines. */
const OVERFLOW_LOG_INTERVAL_MS = 60_000;

/**
 * Enforces MAX_QUEUED_EVENTS on the telemetry event queue. Holds the
 * throttle state for overflow logging so the policy is unit-testable in
 * isolation from the TelemetryManager singleton.
 */
export class TelemetryEventQueueCap {
  private droppedSinceLastLog = 0;
  private lastDropLogAt = 0;

  /**
   * Trim the queue to MAX_QUEUED_EVENTS by dropping the OLDEST events (front
   * of the array; failed re-queues are unshifted there ahead of newer
   * arrivals). Emits at most one throttled debug line per interval with the
   * number of events dropped since the previous line. Returns the number of
   * events dropped by this call.
   */
  enforce<T>(queue: T[], now: number = Date.now()): number {
    const overflow = queue.length - MAX_QUEUED_EVENTS;
    if (overflow <= 0) {
      return 0;
    }
    queue.splice(0, overflow);
    this.droppedSinceLastLog += overflow;
    if (now - this.lastDropLogAt >= OVERFLOW_LOG_INTERVAL_MS) {
      this.lastDropLogAt = now;
      debugWarn(
        "telemetry",
        `Telemetry event queue is full (${MAX_QUEUED_EVENTS} events); dropped ${this.droppedSinceLastLog} oldest event(s). The telemetry endpoint may be unreachable.`,
      );
      this.droppedSinceLastLog = 0;
    }
    return overflow;
  }
}
