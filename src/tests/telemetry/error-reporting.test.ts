import { describe, expect, mock, test } from "bun:test";
import { telemetry } from "../../telemetry";
import {
  formatTelemetryErrorMessage,
  trackBoundaryError,
} from "../../telemetry/errorReporting";

describe("telemetry error reporting helper", () => {
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
