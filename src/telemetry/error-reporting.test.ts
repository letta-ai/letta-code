import { describe, expect, mock, spyOn, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import { telemetry } from "@/telemetry";
import {
  formatTelemetryErrorMessage,
  reportExternalWorkerLaunchFailure,
  trackBoundaryError,
} from "@/telemetry/error-reporting";

describe("telemetry error reporting helper", () => {
  test("reports the HTTP status of an API request error during worker launch", () => {
    const trackError = spyOn(telemetry, "trackError").mockImplementation(
      () => {},
    );
    const flush = spyOn(telemetry, "flush").mockResolvedValue(undefined);

    try {
      reportExternalWorkerLaunchFailure({
        stage: "resolve_computer",
        harness: "external",
        error: new ApiRequestError("API error (520): <html>", 520, "<html>"),
      });

      expect(trackError).toHaveBeenCalledWith(
        "external_worker_launch_failed",
        "External worker launch failed",
        JSON.stringify({ stage: "resolve_computer", harness: "external" }),
        { httpStatus: 520, omitDebugLogTail: true },
      );
    } finally {
      trackError.mockRestore();
      flush.mockRestore();
    }
  });

  test("formats error values safely", () => {
    expect(formatTelemetryErrorMessage(new Error("boom"))).toBe("boom");
    expect(formatTelemetryErrorMessage("oops")).toBe("oops");
    expect(formatTelemetryErrorMessage({ foo: "bar" })).toBe(
      JSON.stringify({ foo: "bar" }),
    );

    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(formatTelemetryErrorMessage(circular)).toContain("[object Object]");
  });

  test("forwards boundary fields into telemetry.trackError", () => {
    const originalTrackError = telemetry.trackError;
    const trackErrorMock = mock(() => {});

    telemetry.trackError = trackErrorMock as typeof telemetry.trackError;

    try {
      trackBoundaryError({
        errorType: "listener_queue_pump_failed",
        error: new Error("queue exploded"),
        context: "listener_queue_pump",
        runId: "run-123",
        httpStatus: 503,
      });

      expect(trackErrorMock).toHaveBeenCalledWith(
        "listener_queue_pump_failed",
        "queue exploded",
        "listener_queue_pump",
        {
          httpStatus: 503,
          modelId: undefined,
          runId: "run-123",
          recentChunks: undefined,
        },
      );
    } finally {
      telemetry.trackError = originalTrackError;
    }
  });
});
