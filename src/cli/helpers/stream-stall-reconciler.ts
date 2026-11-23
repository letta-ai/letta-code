import { telemetry } from "@/telemetry";
import { debugWarn } from "@/utils/debug";

const DEFAULT_STREAM_STALL_RECONCILE_MS = 60_000;
const DEFAULT_STREAM_STALL_STATUS_TIMEOUT_MS = 5_000;

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

function getStatusLookupTimeoutMs(): number {
  const raw = process.env.LETTA_STREAM_STALL_STATUS_TIMEOUT_MS;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_STREAM_STALL_STATUS_TIMEOUT_MS;
}

const ACTIVE_RUN_STATUSES = new Set([
  "created",
  "not_started",
  "pending",
  "running",
]);

export type StreamStallReconciler = {
  arm: () => void;
  clear: () => void;
  fired: () => boolean;
};

export function createStreamStallReconciler(context: {
  getRunId: () => string | null;
  getStopReason: () => string | null;
  canResumeWithoutRunId: () => boolean;
  retrieveRunStatus: (
    runId: string,
    signal: AbortSignal,
  ) => Promise<string | null | undefined>;
  abortHttpRead: () => void;
}): StreamStallReconciler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let cleared = false;
  let reconciling = false;
  let activityGeneration = 0;

  const abortDeadRead = (runId: string | null, status: string | null) => {
    fired = true;
    const reason = status
      ? `run ${runId} is ${status} server-side`
      : runId
        ? `run ${runId} status could not be checked`
        : "no run id arrived";
    debugWarn(
      "drainStream",
      "Stall reconciler fired: %s and the stream went silent before its terminal sequence - aborting HTTP read to trigger resume",
      reason,
    );
    telemetry.trackError(
      "stream_stall_reconciler_fired",
      `Stream went silent before its terminal sequence; ${reason}; aborted the dead read to resume`,
      "stream_drain",
      runId ? { runId } : undefined,
    );
    context.abortHttpRead();
  };

  const arm = () => {
    if (cleared || fired) {
      return;
    }
    activityGeneration += 1;
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
    if (context.getStopReason() !== null) {
      return;
    }
    const runId = context.getRunId();
    if (!runId) {
      if (context.canResumeWithoutRunId()) {
        abortDeadRead(null, null);
      } else {
        arm();
      }
      return;
    }
    const reconciliationGeneration = activityGeneration;
    reconciling = true;
    void (async () => {
      let status: string | null | undefined;
      const statusAbortController = new AbortController();
      let lookupTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        status = await Promise.race([
          context.retrieveRunStatus(runId, statusAbortController.signal),
          new Promise<never>((_resolve, reject) => {
            lookupTimeout = setTimeout(() => {
              statusAbortController.abort();
              reject(new Error("Run status lookup timed out"));
            }, getStatusLookupTimeoutMs());
          }),
        ]);
      } catch (error) {
        status = undefined;
        telemetry.trackError(
          "stream_stall_status_lookup_failed",
          error instanceof Error ? error.message : String(error),
          "stream_drain",
          { runId },
        );
      } finally {
        if (lookupTimeout) {
          clearTimeout(lookupTimeout);
        }
      }
      reconciling = false;
      if (
        cleared ||
        fired ||
        context.getStopReason() !== null ||
        activityGeneration !== reconciliationGeneration
      ) {
        if (
          activityGeneration !== reconciliationGeneration &&
          !timer &&
          !cleared &&
          !fired &&
          context.getStopReason() === null
        ) {
          arm();
        }
        return;
      }
      if (status != null && ACTIVE_RUN_STATUSES.has(status)) {
        arm();
        return;
      }
      abortDeadRead(runId, status ?? null);
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
