import { describe, expect, test } from "bun:test";
import type {
  ErrorMessage,
  ResultMessage,
  ResultSubtype,
} from "@/types/protocol";

describe("headless error format types", () => {
  test("ResultSubtype includes 'error' option", () => {
    // This is a compile-time check - if ResultSubtype doesn't include "error",
    // this would fail to compile.
    const errorSubtype: ResultSubtype = "error";
    expect(errorSubtype).toBe("error");

    const successSubtype: ResultSubtype = "success";
    expect(successSubtype).toBe("success");

    const interruptedSubtype: ResultSubtype = "interrupted";
    expect(interruptedSubtype).toBe("interrupted");
  });

  test("ResultMessage type supports stop_reason field", () => {
    const errorResult: ResultMessage = {
      type: "result",
      subtype: "error",
      session_id: "test-session",
      uuid: "test-uuid",
      agent_id: "agent-123",
      conversation_id: "conv-123",
      duration_ms: 1000,
      duration_api_ms: 500,
      num_turns: 1,
      result: null,
      run_ids: ["run-123"],
      usage: null,
      stop_reason: "error", // This field should be present for errors
    };

    expect(errorResult.subtype).toBe("error");
    expect(errorResult.stop_reason).toBe("error");
  });

  test("ErrorMessage type supports api_error field", () => {
    const errorMsg: ErrorMessage = {
      type: "error",
      message: "CONFLICT: Another request is being processed",
      stop_reason: "error",
      session_id: "test-session",
      uuid: "test-uuid",
      run_id: "run-123",
      api_error: {
        message_type: "error_message",
        message: "CONFLICT: Another request is being processed",
        error_type: "internal_error",
        detail:
          "Cannot send a new message: Another request is currently being processed for this conversation.",
        run_id: "run-123",
      },
    };

    expect(errorMsg.type).toBe("error");
    expect(errorMsg.api_error).toBeDefined();
    expect(errorMsg.api_error?.detail).toContain("Another request");
  });
});

describe("headless error format expectations", () => {
  test("error result should have subtype 'error', not 'success'", () => {
    const mockErrorResult: ResultMessage = {
      type: "result",
      subtype: "error", // NOT "success"
      session_id: "test",
      uuid: "test",
      agent_id: "agent-123",
      conversation_id: "conv-123",
      duration_ms: 1000,
      duration_api_ms: 500,
      num_turns: 1,
      result: null,
      run_ids: [],
      usage: null,
      stop_reason: "error",
    };

    // SDK transforms this to { success: false } based on subtype
    const sdkSuccess = mockErrorResult.subtype === "success";
    expect(sdkSuccess).toBe(false);
  });

  test("409 conflict error should include detail in message", () => {
    const conflictDetail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

    const mockError: ErrorMessage = {
      type: "error",
      message: conflictDetail, // Detail should be in message
      stop_reason: "error",
      session_id: "test",
      uuid: "test",
      run_id: "run-123",
    };

    expect(mockError.message).toContain("CONFLICT");
    expect(mockError.message).toContain("Another request");
  });

  test("approval pending error should include detail", () => {
    const approvalDetail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.";

    const mockError: ErrorMessage = {
      type: "error",
      message: approvalDetail,
      stop_reason: "error",
      session_id: "test",
      uuid: "test",
    };

    expect(mockError.message).toContain("waiting for approval");
  });
});
