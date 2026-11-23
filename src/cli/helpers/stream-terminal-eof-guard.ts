import { telemetry } from "@/telemetry";
import { debugWarn } from "@/utils/debug";

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
  untilEof: <T>(stream: AsyncIterable<T>) => AsyncIterable<T>;
  arm: () => void;
  clear: () => void;
  fired: () => boolean;
};

export function createTerminalEofGuard(context: {
  getStopReason: () => string | null;
  getRunId: () => string | null;
  abortHttpRead: () => void;
}): TerminalEofGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const eof = { done: true, value: undefined } as const;
  let deadline: PromiseWithResolvers<typeof eof> | undefined;
  let closeIterator: (() => void) | undefined;

  return {
    untilEof<T>(stream: AsyncIterable<T>): AsyncIterable<T> {
      return {
        [Symbol.asyncIterator]() {
          const iterator = stream[Symbol.asyncIterator]();
          closeIterator = () => {
            void iterator.return?.().catch(() => {});
          };
          return {
            next() {
              if (!deadline) return iterator.next();
              if (fired) return Promise.resolve(eof);
              return Promise.race([iterator.next(), deadline.promise]);
            },
            return: iterator.return?.bind(iterator),
          };
        },
      };
    },
    arm: () => {
      if (timer) {
        clearTimeout(timer);
      }
      const graceMs = getTerminalEofGraceMs();
      deadline = Promise.withResolvers<typeof eof>();
      timer = setTimeout(() => {
        fired = true;
        deadline?.resolve(eof);
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
        closeIterator?.();
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
