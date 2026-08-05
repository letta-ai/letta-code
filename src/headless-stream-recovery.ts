import type { Backend } from "@/backend";
import type {
  StreamRecoveryFailure,
  StreamRecoveryPolicy,
} from "@/cli/helpers/stream-recovery";
import { isActiveRunWithoutError } from "@/cli/helpers/stream-recovery";
import type { StreamRecoveryErrorDetails } from "@/types/protocol";

export const HEADLESS_STREAM_RECOVERY_POLICY: StreamRecoveryPolicy = {
  deadlineMs: 30_000,
  initialDelayMs: 250,
  maxAttempts: 20,
  maxDelayMs: 2_000,
};

export type HeadlessStreamRecoveryCancellation = {
  attempted: boolean;
  error?: string;
  observedRunStatus?: StreamRecoveryFailure["finalRunStatus"];
  observedStopReason?: StreamRecoveryFailure["finalStopReason"];
  succeeded: boolean;
};

export type HeadlessStreamRecoveryOutcome = {
  details: StreamRecoveryErrorDetails;
  message: string;
};

export async function cancelAbandonedActiveRun(params: {
  agentId: string;
  backend: Backend;
  failure: StreamRecoveryFailure;
}): Promise<HeadlessStreamRecoveryCancellation> {
  const { agentId, backend, failure } = params;
  if (
    !failure.runId ||
    (failure.finalRunStatus !== "created" &&
      failure.finalRunStatus !== "running")
  ) {
    return { attempted: false, succeeded: false };
  }

  let cancelAgentId = agentId;
  let observedRunStatus: StreamRecoveryFailure["finalRunStatus"] = null;
  let observedStopReason: StreamRecoveryFailure["finalStopReason"] = null;
  try {
    const latestRun = await backend.retrieveRun(failure.runId);
    observedRunStatus = latestRun.status ?? null;
    observedStopReason = latestRun.stop_reason ?? null;
    if (!isActiveRunWithoutError(latestRun)) {
      return {
        attempted: false,
        observedRunStatus,
        observedStopReason,
        succeeded: false,
      };
    }
    cancelAgentId = latestRun.agent_id || agentId;
  } catch {
    // The last recovery observation was active. Still make the best-effort
    // cancellation attempt if the final status check is unavailable.
  }

  try {
    const result = await backend.cancelRun(cancelAgentId, failure.runId);
    if (result[failure.runId] !== "cancelled") {
      throw new Error(`Backend did not cancel run ${failure.runId}`);
    }
    return {
      attempted: true,
      observedRunStatus,
      observedStopReason,
      succeeded: true,
    };
  } catch (error) {
    return {
      attempted: true,
      error: error instanceof Error ? error.message : String(error),
      observedRunStatus,
      observedStopReason,
      succeeded: false,
    };
  }
}

export function formatStreamRecoveryFailure(
  failure: StreamRecoveryFailure,
): string {
  return [
    `Stream recovery failed after ${failure.attempts} attempt${failure.attempts === 1 ? "" : "s"}`,
    failure.runId ? `for run ${failure.runId}` : "before a run ID was observed",
    `(last sequence: ${failure.lastSeqId ?? "unknown"}, final status: ${failure.finalRunStatus ?? "unknown"}, final stop reason: ${failure.finalStopReason ?? "none"})`,
    failure.underlyingError,
  ].join(": ");
}

export function toStreamRecoveryErrorDetails(
  failure: StreamRecoveryFailure,
  cancellation: HeadlessStreamRecoveryCancellation,
): StreamRecoveryErrorDetails {
  return {
    code: "stream_recovery_failed",
    attempts: failure.attempts,
    run_id: failure.runId,
    last_sequence_id: failure.lastSeqId,
    underlying_error: failure.underlyingError,
    final_run_status:
      cancellation.observedRunStatus ?? failure.finalRunStatus ?? null,
    final_stop_reason:
      cancellation.observedStopReason ?? failure.finalStopReason ?? null,
    cancel_attempted: cancellation.attempted,
    cancel_succeeded: cancellation.succeeded,
    ...(cancellation.error && { cancel_error: cancellation.error }),
  };
}

export async function finalizeHeadlessStreamRecovery(params: {
  agentId: string;
  backend: Backend;
  failure: StreamRecoveryFailure;
}): Promise<HeadlessStreamRecoveryOutcome> {
  const cancellation = await cancelAbandonedActiveRun(params);
  return {
    details: toStreamRecoveryErrorDetails(params.failure, cancellation),
    message: formatStreamRecoveryFailure(params.failure),
  };
}
