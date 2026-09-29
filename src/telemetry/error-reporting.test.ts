import { describe, expect, mock, test } from "bun:test";
import { telemetry } from "@/telemetry";
import {
  formatTelemetryErrorMessage,
  reportListenerStateWriteFailure,
  trackBoundaryError,
} from "@/telemetry/error-reporting";

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

  test("reports a filesystem code and IDs without forwarding paths or record data", () => {
    const original = telemetry.trackError;
    const originalFlush = telemetry.flush;
    const tracked = mock(() => {});
    telemetry.trackError = tracked as typeof telemetry.trackError;
    telemetry.flush = mock(async () => {});
    try {
      reportListenerStateWriteFailure({
        phase: "before_tool_execution",
        operation: "write",
        error: Object.assign(new Error("/private/workspace/state.json"), {
          code: "ENOSPC",
        }),
        agentId: "agent-test",
        conversationId: "conv-test",
        runId: "run-test",
        toolCallIds: ["call-test", "/private/path"],
      });
      expect(tracked).toHaveBeenCalledWith(
        "listener_state_write_failed",
        "Listener state write failed",
        expect.any(String),
        {
          runId: "run-test",
          omitDebugLogTail: true,
        },
      );
      const context = JSON.parse(
        (tracked.mock.calls[0] as unknown as [string, string, string])[2],
      );
      expect(context).toEqual({
        boundary: "listener_interrupted_turn_record",
        phase: "before_tool_execution",
        operation: "write",
        error_code: "ENOSPC",
        agent_id: "agent-test",
        conversation_id: "conv-test",
        tool_call_ids: ["call-test"],
        tool_call_count: 2,
      });
      expect(JSON.stringify(tracked.mock.calls)).not.toContain("/private/");
    } finally {
      telemetry.trackError = original;
      telemetry.flush = originalFlush;
    }
  });
});
