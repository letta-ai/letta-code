import { telemetry } from "@/telemetry";
import { debugWarn } from "@/utils/debug";

/**
 * Mid-stream stall reconciler for message streams.
 *
 * drainStream reads the SSE body with `for await`; if the HTTP response
 * stalls before the terminal sequence (dead socket with no FIN/RST, frames
 * lost in transit), the iterator neither yields nor throws and the turn
 * wedges in PROCESSING_API_RESPONSE forever. Seen in production as a run
 * that completed server-side with requires_approval whose approval request
 * never reached the client — no approval prompt, no way to cancel, stuck
 * until process restart.
 *
 * The terminal-EOF guard (stream-terminal-eof-guard.ts) only covers stalls
 * AFTER stop_reason arrived. This reconciler covers stalls BEFORE it:
 * streams request include_pings and the server emits a keepalive ping every
 * ~20s during quiet periods, so sustained silence means the stream is dead,
 * not slow. On each firing the reconciler asks the server whether the run
 * already ended; only then does it abort the dead HTTP read, which lets
 * drainStream return and drainStreamWithResume replay the lost tail
 * (including any approval request) from the run's persisted stream.
 *
 * Fail-safe by construction: if the run is still active server-side, or its
 * status cannot be determined (no run_id yet, lookup error), the reconciler
 * re-arms and keeps waiting. It never aborts a stream the server considers
 * live.
 */

// 3x the server keepalive interval (~20s): one missed ping could be jitter,
// three in a row is a dead stream.
const DEFAULT_STREAM_STALL_RECONCILE_MS = 60_000;

function getStallReconcileMs(): number {
  const raw = process.env.LETTA_STREAM_STALL_RECONCILE_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_STREAM_STALL_RECONCILE_MS;
}

/** Run statuses under which the stream may still legitimately produce data. */
const ACTIVE_RUN_STATUSES = new Set([
  "created",
  "not_started",
  "pending",
  "running",
]);

export type StreamStallReconciler = {
  /** (Re-)start the silence timer. Call at stream start and on every chunk. */
  arm: () => void;
  /** Cancel the timer. Call when the stream ends for any reason. */
  clear: () => void;
  /** True if the reconciler aborted the HTTP read. */
  fired: () => boolean;
};

export function createStreamStallReconciler(context: {
  getRunId: () => string | null;
  getStopReason: () => string | null;
  /** Fetch the run's current server-side status; may throw. */
  retrieveRunStatus: (runId: string) => Promise<string | null | undefined>;
  abortHttpRead: () => void;
}): StreamStallReconciler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let cleared = false;
  let reconciling = false;

  const arm = () => {
    if (cleared || fired) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(onSilenceElapsed, getStallReconcileMs());
  };

  const onSilenceElapsed = () => {
    timer = null;
    if (cleared || fired || reconciling) {
      return;
    }
    // After stop_reason the terminal-EOF guard owns the stream's end.
    if (context.getStopReason() !== null) {
      return;
    }
    const runId = context.getRunId();
    if (!runId) {
      // Stalled before any run_id-bearing chunk: nothing to reconcile
      // against yet. Keep waiting.
      arm();
      return;
    }
    reconciling = true;
    void (async () => {
      let status: string | null | undefined;
      try {
        status = await context.retrieveRunStatus(runId);
      } catch {
        // Server unreachable or lookup failed: keep waiting and retry on
        // the next silence window.
        status = undefined;
      }
      reconciling = false;
      if (cleared || fired || context.getStopReason() !== null) {
        return;
      }
      if (status == null || ACTIVE_RUN_STATUSES.has(status)) {
        arm();
        return;
      }
      // The run already ended server-side but this stream never delivered
      // the tail: the read is dead. Abort it so the resume path can replay
      // the missing chunks from the persisted run stream.
      fired = true;
      debugWarn(
        "drainStream",
        "Stall reconciler fired: run %s is %s server-side but the stream went silent before its terminal sequence - aborting HTTP read to trigger resume",
        runId,
        status,
      );
      telemetry.trackError(
        "stream_stall_reconciler_fired",
        `Stream went silent while run reached server-side status ${status}; aborted the dead read to resume`,
        "stream_drain",
        { runId },
      );
      context.abortHttpRead();
    })();
  };

  return {
    arm,
    clear: () => {
      cleared = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    fired: () => fired,
  };
}
