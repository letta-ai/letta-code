import { isBusyRecoveryEnabled, reportBusyRecovery } from "./busy-recovery";

const pendingByBackend = new WeakMap<object, Set<string>>();
let activeObservers = 0;

export function markBusyRequest(
  backend: object,
  conversationId: string,
  otid?: string,
): void {
  if (!otid || !isBusyRecoveryEnabled()) return;
  const pending = pendingByBackend.get(backend) ?? new Set<string>();
  pending.add(JSON.stringify([conversationId, otid]));
  if (pending.size > 128) pending.delete(pending.values().next().value ?? "");
  pendingByBackend.set(backend, pending);
}

interface ProgressClock {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Observe original streams too; ordinary short successful sends emit nothing. */
export function traceBusyRecoveryStream<T extends AsyncIterable<unknown>>(
  stream: T,
  conversationId: string,
  otid: string | undefined,
  signal?: AbortSignal,
  backend?: object,
  clock: ProgressClock = {},
): T {
  if (!isBusyRecoveryEnabled() || activeObservers >= 128) return stream;
  activeObservers += 1;
  const recovered =
    !backend ||
    Boolean(
      pendingByBackend
        .get(backend)
        ?.delete(JSON.stringify([conversationId, otid])),
    );
  const now = clock.now ?? Date.now;
  const schedule =
    clock.schedule ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  const original = stream[Symbol.asyncIterator].bind(stream);
  const startedAt = now();
  let lastChunkAt = startedAt;
  let chunkCount = 0;
  let pendingReads = 0;
  let lastChunkType: unknown;
  let requestRunId: string | undefined;
  let stopReason: unknown;
  let finished = false;
  let reportedProgress = false;
  const fields = () => ({
    conversationId,
    otid,
    requestRunId,
    stopReason,
    chunkCount,
    readPending: pendingReads > 0,
    lastChunkType,
    elapsedMs: now() - startedAt,
    idleMs: now() - lastChunkAt,
  });
  let cancelTimer = () => {};
  const checkpoint = () => {
    if (finished) return;
    reportedProgress = true;
    reportBusyRecovery("stream_progress", fields());
    cancelTimer = schedule(() => {
      if (!finished) reportBusyRecovery("stream_waiting", fields());
    }, 240000);
  };
  cancelTimer = schedule(() => checkpoint(), 60000);
  const finish = (
    phase:
      | "stream_eof"
      | "stream_failed"
      | "stream_cancelled"
      | "stream_closed",
  ) => {
    if (finished) return;
    finished = true;
    cancelTimer();
    signal?.removeEventListener("abort", onAbort);
    activeObservers -= 1;
    if (recovered || reportedProgress || phase === "stream_failed")
      reportBusyRecovery(phase, fields());
  };
  const onAbort = () => finish("stream_cancelled");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  stream[Symbol.asyncIterator] = () => {
    const iterator = original();
    return {
      async next() {
        pendingReads += 1;
        try {
          const result = await iterator.next();
          if (result.done)
            finish(signal?.aborted ? "stream_cancelled" : "stream_eof");
          else {
            chunkCount += 1;
            lastChunkAt = now();
            if (result.value && typeof result.value === "object") {
              const chunk = result.value as Record<string, unknown>;
              lastChunkType = chunk.message_type;
              if (typeof chunk.run_id === "string") requestRunId = chunk.run_id;
              if (chunk.message_type === "stop_reason")
                stopReason = chunk.stop_reason;
            }
          }
          return result;
        } catch (error) {
          finish(signal?.aborted ? "stream_cancelled" : "stream_failed");
          throw error;
        } finally {
          pendingReads -= 1;
        }
      },
      async return(value?: unknown) {
        try {
          return iterator.return
            ? await iterator.return(value)
            : { done: true as const, value };
        } finally {
          finish(signal?.aborted ? "stream_cancelled" : "stream_closed");
        }
      },
      async throw(error?: unknown) {
        try {
          if (iterator.throw) return await iterator.throw(error);
          throw error;
        } finally {
          finish(signal?.aborted ? "stream_cancelled" : "stream_failed");
        }
      },
    };
  };
  return stream;
}
