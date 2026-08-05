import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Backend } from "@/backend";
import type { StreamRecoveryFailure } from "@/cli/helpers/stream-recovery";
import {
  cancelAbandonedActiveRun,
  formatStreamRecoveryFailure,
  toStreamRecoveryErrorDetails,
} from "@/headless-stream-recovery";

function failure(
  status: StreamRecoveryFailure["finalRunStatus"] = "running",
): StreamRecoveryFailure {
  return {
    attempts: 4,
    finalRunStatus: status,
    finalStopReason: null,
    lastSeqId: 17,
    runId: "run-1",
    underlyingError: "connection reset",
  };
}

describe("headless stream recovery cleanup", () => {
  test("cancels a run that is still active after recovery expires", async () => {
    const cancelRun = mock(async () => ({ "run-1": "cancelled" }));
    const backend = {
      retrieveRun: mock(async () => ({
        id: "run-1",
        agent_id: "agent-from-run",
        status: "running",
      })),
      cancelRun,
    } as unknown as Backend;

    const result = await cancelAbandonedActiveRun({
      agentId: "agent-1",
      backend,
      failure: failure(),
    });

    expect(result).toEqual({
      attempted: true,
      observedRunStatus: "running",
      observedStopReason: null,
      succeeded: true,
    });
    expect(cancelRun).toHaveBeenCalledWith("agent-from-run", "run-1");
  });

  test("does not cancel a run that settled after the final recovery poll", async () => {
    const cancelRun = mock(async () => ({ "run-1": "cancelled" }));
    const backend = {
      retrieveRun: mock(async () => ({
        id: "run-1",
        agent_id: "agent-1",
        status: "completed",
        stop_reason: "end_turn",
      })),
      cancelRun,
    } as unknown as Backend;

    const result = await cancelAbandonedActiveRun({
      agentId: "agent-1",
      backend,
      failure: failure(),
    });

    expect(result).toEqual({
      attempted: false,
      observedRunStatus: "completed",
      observedStopReason: "end_turn",
      succeeded: false,
    });
    expect(cancelRun).not.toHaveBeenCalled();
  });

  test("preserves structured recovery and cancellation diagnostics", () => {
    const recoveryFailure = failure();
    const cancellation = {
      attempted: true,
      error: "cancel request timed out",
      succeeded: false,
    };

    expect(formatStreamRecoveryFailure(recoveryFailure)).toContain(
      "connection reset",
    );
    expect(toStreamRecoveryErrorDetails(recoveryFailure, cancellation)).toEqual(
      {
        code: "stream_recovery_failed",
        attempts: 4,
        run_id: "run-1",
        last_sequence_id: 17,
        underlying_error: "connection reset",
        final_run_status: "running",
        final_stop_reason: null,
        cancel_attempted: true,
        cancel_succeeded: false,
        cancel_error: "cancel request timed out",
      },
    );
  });

  test("one-shot headless opts into recovery without resubmitting failed input", () => {
    const headlessSource = readFileSync(
      fileURLToPath(new URL("./headless.ts", import.meta.url)),
      "utf8",
    );
    const drainStart = headlessSource.indexOf(
      "const result = await drainStreamWithResume(",
    );
    const errorStart = headlessSource.indexOf(
      "// Unexpected stop reason",
      drainStart,
    );
    const segment = headlessSource.slice(drainStart, errorStart);

    expect(segment).toContain("HEADLESS_STREAM_RECOVERY_POLICY");
    expect(segment).toContain("finalizeHeadlessStreamRecovery({");
    expect(segment).toContain("!recoveryFailure &&");
    expect(headlessSource.slice(errorStart)).toContain(
      "stream_recovery: recoveryOutcome.details",
    );
  });
});
