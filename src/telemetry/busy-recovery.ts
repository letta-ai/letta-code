import { telemetry } from "@/telemetry";

type Phase =
  | "send_rejected"
  | "replay_unavailable"
  | "replay_missing_otid"
  | "poll_started"
  | "poll_settled"
  | "poll_failed"
  | "poll_unavailable"
  | "poll_timed_out"
  | "cancelled"
  | "stream_progress"
  | "stream_waiting"
  | "stream_eof"
  | "stream_failed"
  | "stream_cancelled"
  | "stream_closed";
interface Fields {
  conversationId?: string;
  otid?: string;
  blockerRunId?: string;
  requestRunId?: string;
  httpStatus?: number;
  elapsedMs?: number;
  chunkCount?: number;
  idleMs?: number;
  readPending?: boolean;
  lastChunkType?: unknown;
  stopReason?: unknown;
}
const incidents = new Map<string, Set<Phase>>();
const blockers = new Map<string, string>();
let windowStart = 0;
let windowCount = 0;
export function __testResetBusyRecoveryBudget(): void {
  incidents.clear();
  blockers.clear();
  windowStart = 0;
  windowCount = 0;
}
export function isBusyRecoveryEnabled(): boolean {
  return (
    !["0", "false"].includes(process.env.LETTA_CODE_TELEM ?? "") &&
    process.env.DO_NOT_TRACK !== "1"
  );
}
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  if (map.size > 128) map.delete(map.keys().next().value ?? "");
}
// Reserve two snapshots and two outcomes in addition to eight ordinary phases.
function category(phase: Phase): 0 | 1 | 2 {
  if (phase === "stream_progress" || phase === "stream_waiting") return 1;
  return oneOf(
    phase,
    "stream_eof stream_failed stream_cancelled stream_closed poll_timed_out cancelled",
  )
    ? 2
    : 0;
}
function oneOf(value: unknown, allowed: string): string | undefined {
  return typeof value === "string" && allowed.split(" ").includes(value)
    ? value
    : undefined;
}
/** Fixed text, bounded opaque IDs and allowlisted scalar metadata; no content/tails. */
export function reportBusyRecovery(phase: Phase, fields: Fields = {}): void {
  try {
    if (!isBusyRecoveryEnabled()) return;
    const id = (value: string | undefined) =>
      typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
        ? value
        : undefined;
    const count = (value: number | undefined) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
    const conversation = id(fields.conversationId);
    const otid = id(fields.otid);
    const blocker = id(fields.blockerRunId);
    const request = otid ? JSON.stringify([conversation, otid]) : undefined;
    const key =
      request ??
      (blocker
        ? (blockers.get(blocker) ?? blocker)
        : (conversation ?? "unknown"));
    if (request && blocker) remember(blockers, blocker, request);
    const seen = incidents.get(key) ?? new Set<Phase>();
    remember(incidents, key, seen);
    const kind = category(phase);
    if (
      seen.has(phase) ||
      [...seen].filter((p) => category(p) === kind).length >=
        ([8, 2, 2] as const)[kind]
    )
      return;
    const now = Date.now();
    if (now - windowStart >= 120000) {
      windowStart = now;
      windowCount = 0;
    }
    if (windowCount >= ([60, 70, 80] as const)[kind]) return;
    seen.add(phase);
    windowCount += 1;
    telemetry.trackError(
      "conversation_busy_recovery",
      "Conversation stream diagnostic",
      JSON.stringify({
        phase,
        client_timestamp: new Date().toISOString(),
        conversation_id: conversation,
        request_otid: otid,
        blocker_run_id: blocker,
        request_run_id: id(fields.requestRunId),
        elapsed_ms: count(fields.elapsedMs),
        idle_ms: count(fields.idleMs),
        chunk_count: count(fields.chunkCount),
        read_pending:
          typeof fields.readPending === "boolean"
            ? fields.readPending
            : undefined,
        last_chunk_type: oneOf(
          fields.lastChunkType,
          "reasoning_message assistant_message tool_call_message tool_return_message approval_request_message ping stop_reason usage_statistics",
        ),
        stop_reason: oneOf(
          fields.stopReason,
          "end_turn error llm_api_error max_steps max_tokens_exceeded invalid_llm_response invalid_tool_call no_tool_call tool_rule insufficient_credits context_window_overflow_in_system_prompt requires_approval cancelled",
        ),
      }),
      {
        httpStatus:
          Number.isInteger(fields.httpStatus) &&
          (fields.httpStatus ?? 0) >= 100 &&
          (fields.httpStatus ?? 0) <= 599
            ? fields.httpStatus
            : undefined,
        omitDebugLogTail: true,
      },
    );
  } catch {
    /* Diagnostics must never change recovery behavior. */
  }
}
export function getBusyRecoveryHttpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

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
  // Observation expires independently of the underlying stream ending.
  let retired = false;
  const retire = () => {
    if (retired) return;
    retired = true;
    cancelTimer();
    signal?.removeEventListener("abort", onAbort);
    activeObservers -= 1;
  };
  const checkpoint = () => {
    if (finished) return;
    reportedProgress = true;
    reportBusyRecovery("stream_progress", fields());
    cancelTimer = schedule(() => {
      if (!finished) reportBusyRecovery("stream_waiting", fields());
      retire();
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
    retire();
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
