import { reportBusyRecovery } from "./busy-recovery";

// Rejected sends may be retried with the same OTID. Bound abandoned requests.
const pendingByBackend = new WeakMap<object, Set<string>>();

export function markBusyRequest(
  backend: object,
  conversationId: string,
  otid?: string,
): void {
  if (!otid) return;
  const pending = pendingByBackend.get(backend) ?? new Set<string>();
  pending.add(JSON.stringify([conversationId, otid]));
  if (pending.size > 128) {
    const oldest = pending.values().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pendingByBackend.set(backend, pending);
}

export function traceBusyRecoveryStream<T extends AsyncIterable<unknown>>(
  stream: T,
  conversationId: string,
  otid: string | undefined,
  signal?: AbortSignal,
  backend?: object,
): T {
  if (backend) {
    const pending = pendingByBackend.get(backend);
    if (!pending?.delete(JSON.stringify([conversationId, otid]))) return stream;
  }
  const original = stream[Symbol.asyncIterator].bind(stream);
  const startedAt = Date.now();
  let requestRunId: string | undefined;
  let stopReason: unknown;
  let finished = false;
  const finish = (
    phase:
      | "stream_eof"
      | "stream_failed"
      | "stream_cancelled"
      | "stream_closed",
  ) => {
    if (finished) return;
    finished = true;
    reportBusyRecovery(phase, {
      conversationId,
      otid,
      requestRunId,
      stopReason,
      elapsedMs: Date.now() - startedAt,
    });
  };
  stream[Symbol.asyncIterator] = () => {
    const iterator = original();
    return {
      async next() {
        try {
          const result = await iterator.next();
          if (result.done)
            finish(signal?.aborted ? "stream_cancelled" : "stream_eof");
          else if (result.value && typeof result.value === "object") {
            const chunk = result.value as Record<string, unknown>;
            if (typeof chunk.run_id === "string") requestRunId = chunk.run_id;
            if (chunk.message_type === "stop_reason") {
              stopReason = chunk.stop_reason;
              reportBusyRecovery("stream_stop_received", {
                conversationId,
                otid,
                requestRunId,
                stopReason,
                elapsedMs: Date.now() - startedAt,
              });
            }
          }
          return result;
        } catch (error) {
          finish(signal?.aborted ? "stream_cancelled" : "stream_failed");
          throw error;
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
  reportBusyRecovery("stream_attached", { conversationId, otid });
  return stream;
}
