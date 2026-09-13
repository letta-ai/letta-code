import { unrefTimer } from "./process_manager.js";

export const MONITOR_EVENT_BATCH_MS = 200;
export const MONITOR_EVENT_LINE_CHARS = 500;
export const MONITOR_EVENT_BATCH_CHARS = 3000;
export const MONITOR_EVENT_BUFFER_CHARS = 1024 * 1024;
export const MONITOR_EVENT_INITIAL_TOKENS = 10;
export const MONITOR_EVENT_REFILL_MS = 2000;
export const MONITOR_EVENT_SUPPRESSION_STOP_MS = 30_000;

type ScheduleFlush = (callback: () => void) => () => void;

export interface MonitorEventStream {
  onData(text: string): void;
  finish(): void;
  cancel(): void;
  isStopped(): boolean;
}

interface MonitorEventStreamOptions {
  emit(event: string): void;
  stopSource(): void;
  now?: () => number;
  scheduleFlush?: ScheduleFlush;
}

function scheduleDefaultFlush(callback: () => void): () => void {
  const timer = setTimeout(callback, MONITOR_EVENT_BATCH_MS);
  unrefTimer(timer);
  return () => clearTimeout(timer);
}

function truncateLine(line: string): string {
  if (line.length <= MONITOR_EVENT_LINE_CHARS) {
    return line;
  }
  return `${line.slice(0, MONITOR_EVENT_LINE_CHARS)}...(truncated)`;
}

function truncateBatch(batch: string): string {
  if (batch.length <= MONITOR_EVENT_BATCH_CHARS) {
    return batch;
  }
  return `${batch.slice(0, MONITOR_EVENT_BATCH_CHARS)}\n...(truncated)`;
}

function createTokenBucket(now: () => number): { tryConsume(): boolean } {
  let tokens = MONITOR_EVENT_INITIAL_TOKENS;
  let lastRefillAt = now();

  return {
    tryConsume(): boolean {
      const currentTime = now();
      const refillCount = Math.floor(
        (currentTime - lastRefillAt) / MONITOR_EVENT_REFILL_MS,
      );
      if (refillCount > 0) {
        tokens = Math.min(MONITOR_EVENT_INITIAL_TOKENS, tokens + refillCount);
        lastRefillAt += refillCount * MONITOR_EVENT_REFILL_MS;
      }
      if (tokens === 0) {
        return false;
      }
      tokens -= 1;
      return true;
    },
  };
}

export function createMonitorEventStream(
  options: MonitorEventStreamOptions,
): MonitorEventStream {
  const now = options.now ?? Date.now;
  const scheduleFlush = options.scheduleFlush ?? scheduleDefaultFlush;
  const bucket = createTokenBucket(now);
  let partialLine = "";
  let pendingLines: string[] = [];
  let pendingChars = 0;
  let pendingBatchFull = false;
  let pendingBatchDropped = false;
  let cancelScheduledFlush: (() => void) | undefined;
  let stopped = false;
  let suppressedCount = 0;
  let suppressionStartedAt: number | undefined;
  let lastSuppressedAt: number | undefined;

  const appendPendingLine = (line: string): void => {
    if (pendingBatchFull) {
      pendingBatchDropped = true;
      return;
    }
    pendingChars += line.length + (pendingLines.length > 0 ? 1 : 0);
    pendingLines.push(line);
    pendingBatchFull = pendingChars >= MONITOR_EVENT_BATCH_CHARS;
  };

  const emitBatch = (batch: string): void => {
    if (stopped) return;
    if (bucket.tryConsume()) {
      if (suppressedCount > 0) {
        options.emit(
          `[${suppressedCount} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
        );
        suppressedCount = 0;
        if (
          lastSuppressedAt !== undefined &&
          now() - lastSuppressedAt > MONITOR_EVENT_REFILL_MS * 3
        ) {
          suppressionStartedAt = undefined;
        }
      }
      options.emit(batch);
      return;
    }

    suppressedCount += 1;
    lastSuppressedAt = now();
    suppressionStartedAt ??= lastSuppressedAt;
    if (
      lastSuppressedAt - suppressionStartedAt >
      MONITOR_EVENT_SUPPRESSION_STOP_MS
    ) {
      stopped = true;
      options.emit(
        `[Monitor stopped — too much output (${suppressedCount} events suppressed over ${Math.round((lastSuppressedAt - suppressionStartedAt) / 1000)}s). Restart with a more selective source.]`,
      );
      options.stopSource();
    }
  };

  const flush = (includePartialLine: boolean): void => {
    cancelScheduledFlush?.();
    cancelScheduledFlush = undefined;

    if (includePartialLine && partialLine.trim()) {
      appendPendingLine(truncateLine(partialLine.trim()));
      partialLine = "";
    }
    if (pendingLines.length === 0) {
      return;
    }

    const joined = pendingLines.join("\n");
    const batch = pendingBatchDropped
      ? `${joined.slice(0, MONITOR_EVENT_BATCH_CHARS)}\n...(truncated)`
      : truncateBatch(joined);
    pendingLines = [];
    pendingChars = 0;
    pendingBatchFull = false;
    pendingBatchDropped = false;
    emitBatch(batch);
  };

  const onData = (text: string): void => {
    if (stopped) return;
    partialLine += text;
    if (partialLine.length > MONITOR_EVENT_BUFFER_CHARS) {
      partialLine = partialLine.slice(-MONITOR_EVENT_BUFFER_CHARS);
    }

    let newlineIndex = partialLine.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = partialLine.slice(0, newlineIndex).trim();
      partialLine = partialLine.slice(newlineIndex + 1);
      if (line) {
        appendPendingLine(truncateLine(line));
      }
      newlineIndex = partialLine.indexOf("\n");
    }

    if (pendingLines.length > 0 && !cancelScheduledFlush) {
      cancelScheduledFlush = scheduleFlush(() => flush(false));
    }
  };

  return {
    onData,
    finish(): void {
      if (stopped) return;
      flush(true);
      stopped = true;
    },
    cancel(): void {
      cancelScheduledFlush?.();
      cancelScheduledFlush = undefined;
      pendingLines = [];
      pendingChars = 0;
      pendingBatchFull = false;
      pendingBatchDropped = false;
      partialLine = "";
      stopped = true;
    },
    isStopped(): boolean {
      return stopped;
    },
  };
}
