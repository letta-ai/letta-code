import { ApiRequestError } from "@/backend/api/request";
import { debugWarn } from "@/utils/debug";

export const MAX_QUEUED_EVENTS = 2_000;

const OVERFLOW_LOG_INTERVAL_MS = 60_000;

export class TelemetryEventQueueCap {
  private droppedSinceLastLog = 0;
  private lastDropLogAt = 0;

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

export function isPermanentRejection(error: unknown): boolean {
  if (!(error instanceof ApiRequestError)) {
    return false;
  }
  const { status } = error;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
