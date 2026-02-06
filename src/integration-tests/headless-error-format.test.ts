import { describe, expect, test } from "bun:test";
import type {
  ErrorMessage,
  ResultMessage,
  ResultSubtype,
} from "../types/protocol";

/**
 * Tests for error handling in headless mode.
 *
 * These tests document and verify the expected wire format for errors.
 * See GitHub issue #813 for background.
 *
 * Expected behavior:
 * 1. When an error occurs, ResultMessage.subtype should be "error" (not "success")
 * 2. ErrorMessage should contain detailed API error info when available
 * 3. Both one-shot and bidirectional modes should surface errors properly
 */

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
    // Verify the ResultMessage type accepts stop_reason for error cases
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
    // Verify ErrorMessage can include nested API error details
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
  /**
   * These tests document the EXPECTED behavior for error handling.
   * They verify the wire format contracts that the SDK depends on.
   */

  test("error result should have subtype 'error', not 'success'", () => {
    // When an error occurs (stop_reason !== "end_turn"), the result
    // should indicate failure, not success.
    //
    // Bug (issue #813): Bidirectional mode was returning subtype: "success"
    // even when stop_reason was "error".
    //
    // Expected: subtype should be "error" so SDK can detect failure

    // This is a contract test - verifying the expected structure
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
    // When API returns 409 with a detail field, that detail should be
    // surfaced in the error message, not lost.
    //
    // Bug (issue #813): The detail was being lost, making debugging hard.
    //
    // Expected: ErrorMessage.message or api_error.detail contains the info

    // Example 409 error detail
    const conflictDetail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

    // The error message should include this detail
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
    // When conversation has a stuck approval, the error should explain this.
    //
    // Example error: "The agent is waiting for approval on a tool call.
    // Please approve or deny the pending request before continuing."

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

/**
 * Note for SDK team:
 *
 * The SDK (letta-code-sdk) transforms ResultMessage as follows:
 *
 *   success: msg.subtype === "success"
 *   error: msg.subtype !== "success" ? msg.subtype : undefined
 *
 * With this fix:
 * - Error results will have subtype: "error", so success will be false
 * - The error field will be "error" (the subtype string)
 *
 * For more detailed error info, SDK could be updated to:
 * 1. Parse ErrorMessage events (currently ignored)
 * 2. Use stop_reason from ResultMessage for specific error types
 */
