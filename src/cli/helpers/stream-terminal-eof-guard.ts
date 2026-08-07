import { telemetry } from "@/telemetry";
import { debugWarn } from "@/utils/debug";

/**
 * Terminal-EOF guard for message streams (LET-10707).
 *
 * The generated letta-client consumes the [DONE] SSE frame internally and only
 * finishes its iterator when the HTTP response body reports EOF. If the server
 * (or an intermediary) never observably ends the response body, the iterator
 * hangs forever and the turn wedges before tool execution — the client has all
 * the semantic content (including the stop reason and any approval requests)
 * but never gets control back. Seen in production as multi-hour stalls in
 * PROCESSING_API_RESPONSE with zero executing tools.
 *
 * The guard arms once a stop_reason chunk has been received and re-arms on
 * every subsequent chunk. After a stop_reason, the server only sends
 * usage_statistics and [DONE], so the guard fires only after sustained silence
 * following the terminal sequence — at which point it aborts the HTTP read.
 * The SDK iterator returns cleanly on its own controller's abort, so
 * drainStream proceeds with the stop reason it already received.
 */
// The terminal frames normally follow within milliseconds (observed ~11ms in
// production traces), and firing early costs nothing: the terminal state is
// already in hand, so the abort only skips waiting for bookkeeping bytes.
// 2s is ~200x the normal gap while keeping the user-visible dead air short.
const DEFAULT_TERMINAL_EOF_GRACE_MS = 2_000;

function getTerminalEofGraceMs(): number {
  const raw = process.env.LETTA_STREAM_TERMINAL_EOF_GRACE_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TERMINAL_EOF_GRACE_MS;
}

export type TerminalEofGuard = {
  /** (Re-)start the grace timer. Call on every chunk after stop_reason. */
  arm: () => void;
  /** Cancel the timer. Call when the stream ends for any reason. */
  clear: () => void;
  /** True if the guard aborted the HTTP read. */
  fired: () => boolean;
};

export function createTerminalEofGuard(context: {
  getStopReason: () => string | null;
  getRunId: () => string | null;
  abortHttpRead: () => void;
}): TerminalEofGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  return {
    arm: () => {
      if (timer) {
        clearTimeout(timer);
      }
      const graceMs = getTerminalEofGraceMs();
      timer = setTimeout(() => {
        fired = true;
        debugWarn(
          "drainStream",
          "Terminal-EOF guard fired: stop_reason=%s received but stream did not end within %dms - aborting HTTP read",
          context.getStopReason(),
          graceMs,
        );
        telemetry.trackError(
          "stream_terminal_eof_guard_fired",
          `Stream received stop_reason=${context.getStopReason()} but HTTP body did not end within ${graceMs}ms`,
          "stream_drain",
          {
            runId: context.getRunId() ?? undefined,
          },
        );
        context.abortHttpRead();
      }, graceMs);
    },
    clear: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    fired: () => fired,
  };
}
