import { describe, expect, test } from "bun:test";
import { __streamTelemetryTestUtils } from "../../cli/helpers/stream";

describe("stream telemetry helpers", () => {
  test("allows mid-stream resume without an abort signal", () => {
    expect(
      __streamTelemetryTestUtils.shouldAttemptMidStreamResume({
        stopReason: "error",
        fallbackError: "socket closed",
        runIdToResume: "run-123",
        runIdSource: "stream_chunk",
        abortSignal: undefined,
      }),
    ).toBe(true);
  });

  test("blocks mid-stream resume only when abort signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      __streamTelemetryTestUtils.shouldAttemptMidStreamResume({
        stopReason: "error",
        fallbackError: "socket closed",
        runIdToResume: "run-123",
        runIdSource: "stream_chunk",
        abortSignal: controller.signal,
      }),
    ).toBe(false);
  });

  test("does not emit terminal telemetry when resume succeeds", () => {
    expect(
      __streamTelemetryTestUtils.buildFinalStreamTelemetry({
        stopReason: "end_turn",
        fallbackError: "socket closed",
        lastRunId: "run-123",
        resumeAttempted: true,
        resumeSource: "stream_chunk",
      }),
    ).toBeNull();
  });

  test("builds one terminal telemetry event when resume ultimately fails", () => {
    expect(
      __streamTelemetryTestUtils.buildFinalStreamTelemetry({
        stopReason: "error",
        fallbackError: "socket closed",
        lastRunId: "run-123",
        resumeAttempted: true,
        resumeSource: "stream_chunk",
        resumeErrorMessage: "resume endpoint closed",
      }),
    ).toEqual({
      errorType: "stream_drain_error",
      errorMessage: "socket closed [resume failed: resume endpoint closed]",
      context: "stream_drain",
      runId: "run-123",
    });
  });

  test("captures skip reasons for terminal failures without duplicate resume telemetry", () => {
    expect(
      __streamTelemetryTestUtils.buildFinalStreamTelemetry({
        stopReason: "error",
        fallbackError: "socket closed",
        lastRunId: null,
        resumeAttempted: false,
        resumeSource: null,
        skipReasons: ["no_run_id", "lookup_failed: timeout"],
      }),
    ).toEqual({
      errorType: "stream_drain_error",
      errorMessage:
        "socket closed [resume skipped: no_run_id, lookup_failed: timeout]",
      context: "stream_drain",
    });
  });
});
