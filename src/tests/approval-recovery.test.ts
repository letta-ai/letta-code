import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import {
  classifyPreStreamConflict,
  extractConflictDetail,
  getPreStreamErrorAction,
  isApprovalPendingError,
  isConversationBusyError,
  isInvalidToolCallIdsError,
  rebuildInputWithFreshDenials,
} from "../agent/approval-recovery";
import { extractApprovals } from "../agent/check-approval";

/**
 * Tests for approval error detection helpers (LET-7101).
 *
 * These functions detect different error conditions related to approvals:
 * 1. isInvalidToolCallIdsError: Tool call IDs don't match server's pending approvals
 * 2. isApprovalPendingError: Sent user message, but server has pending approval waiting
 * 3. isConversationBusyError: Another request is being processed (409 CONFLICT)
 */

describe("isInvalidToolCallIdsError", () => {
  test("detects invalid tool call IDs error", () => {
    const detail =
      "Invalid tool call IDs: Expected ['tc_abc123'], got ['tc_xyz789']";
    expect(isInvalidToolCallIdsError(detail)).toBe(true);
  });

  test("detects invalid tool call IDs error case-insensitively", () => {
    expect(
      isInvalidToolCallIdsError("INVALID TOOL CALL IDS: Expected X, got Y"),
    ).toBe(true);
    expect(isInvalidToolCallIdsError("invalid tool call ids: mismatch")).toBe(
      true,
    );
  });

  test("returns false for 'no tool call awaiting' error", () => {
    // This is a different desync type - server has NO pending approvals
    expect(
      isInvalidToolCallIdsError("No tool call is currently awaiting approval"),
    ).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isInvalidToolCallIdsError("Connection timeout")).toBe(false);
    expect(isInvalidToolCallIdsError("Internal server error")).toBe(false);
    expect(isInvalidToolCallIdsError("Rate limit exceeded")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isInvalidToolCallIdsError(null)).toBe(false);
    expect(isInvalidToolCallIdsError(undefined)).toBe(false);
    expect(isInvalidToolCallIdsError(123)).toBe(false);
    expect(isInvalidToolCallIdsError({ error: "test" })).toBe(false);
  });
});

describe("isApprovalPendingError", () => {
  // This is the actual error format from the Letta backend (screenshot from LET-7101)
  const REAL_ERROR_DETAIL =
    "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.";

  test("detects approval pending error in real error format", () => {
    expect(isApprovalPendingError(REAL_ERROR_DETAIL)).toBe(true);
  });

  test("detects approval pending error case-insensitively", () => {
    expect(isApprovalPendingError("WAITING FOR APPROVAL")).toBe(true);
    expect(isApprovalPendingError("waiting for approval")).toBe(true);
  });

  test("detects partial match in longer message", () => {
    const detail =
      "Error occurred: agent is waiting for approval while processing";
    expect(isApprovalPendingError(detail)).toBe(true);
  });

  test("does not misclassify conversation busy conflict as approval pending", () => {
    const busyDetail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";
    expect(isConversationBusyError(busyDetail)).toBe(true);
    expect(isApprovalPendingError(busyDetail)).toBe(false);
  });

  test("returns false for desync errors (opposite case)", () => {
    // These are the OPPOSITE error - when we send approval but there's nothing pending
    expect(
      isApprovalPendingError("No tool call is currently awaiting approval"),
    ).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isApprovalPendingError("Connection timeout")).toBe(false);
    expect(isApprovalPendingError("Rate limit exceeded")).toBe(false);
    expect(isApprovalPendingError("Invalid API key")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isApprovalPendingError(null)).toBe(false);
    expect(isApprovalPendingError(undefined)).toBe(false);
    expect(isApprovalPendingError(123)).toBe(false);
    expect(isApprovalPendingError({ detail: REAL_ERROR_DETAIL })).toBe(false);
  });
});

describe("isConversationBusyError", () => {
  const REAL_ERROR_DETAIL =
    "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

  test("detects conversation busy error in real error format", () => {
    expect(isConversationBusyError(REAL_ERROR_DETAIL)).toBe(true);
  });

  test("detects conversation busy error case-insensitively", () => {
    expect(
      isConversationBusyError("ANOTHER REQUEST IS CURRENTLY BEING PROCESSED"),
    ).toBe(true);
    expect(
      isConversationBusyError("another request is currently being processed"),
    ).toBe(true);
  });

  test("detects partial match in longer message", () => {
    const detail =
      "Error: Another request is currently being processed. Please wait.";
    expect(isConversationBusyError(detail)).toBe(true);
  });

  test("returns false for approval pending errors (different case)", () => {
    expect(
      isConversationBusyError(
        "Cannot send a new message: The agent is waiting for approval",
      ),
    ).toBe(false);
  });

  test("returns false for unrelated errors", () => {
    expect(isConversationBusyError("Connection timeout")).toBe(false);
    expect(isConversationBusyError("Rate limit exceeded")).toBe(false);
    expect(isConversationBusyError("Invalid API key")).toBe(false);
  });

  test("returns false for non-string input", () => {
    expect(isConversationBusyError(null)).toBe(false);
    expect(isConversationBusyError(undefined)).toBe(false);
    expect(isConversationBusyError(123)).toBe(false);
    expect(isConversationBusyError({ detail: REAL_ERROR_DETAIL })).toBe(false);
  });
});

describe("classifyPreStreamConflict", () => {
  test("classifies approval-pending conflict distinctly from busy conflict", () => {
    const approvalDetail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.";
    const busyDetail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

    expect(classifyPreStreamConflict(approvalDetail)).toBe("approval_pending");
    expect(classifyPreStreamConflict(busyDetail)).toBe("conversation_busy");
  });

  test("returns null for non-conflict errors", () => {
    expect(classifyPreStreamConflict("Rate limit exceeded")).toBeNull();
  });
});

describe("getPreStreamErrorAction", () => {
  test("returns resolve_approval_pending for approval conflict details", () => {
    const detail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.";

    expect(getPreStreamErrorAction(detail, 0, 1)).toBe(
      "resolve_approval_pending",
    );
  });

  test("returns retry_conversation_busy when busy and retries remain", () => {
    const detail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

    expect(getPreStreamErrorAction(detail, 0, 1)).toBe(
      "retry_conversation_busy",
    );
  });

  test("returns rethrow when conversation busy retries are exhausted", () => {
    const detail =
      "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.";

    expect(getPreStreamErrorAction(detail, 1, 1)).toBe("rethrow");
  });

  test("returns rethrow for unrelated errors", () => {
    expect(getPreStreamErrorAction("Rate limit exceeded", 0, 1)).toBe(
      "rethrow",
    );
  });
});

/**
 * Tests for parallel tool call approval extraction.
 * Ensures lazy recovery handles multiple simultaneous tool calls correctly.
 */
describe("extractApprovals", () => {
  // Helper to create a minimal Message-like object for testing
  // We use 'as Message' cast because the real Message type is complex
  const createMessage = (overrides: {
    tool_calls?: Array<{
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    tool_call?: {
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    };
  }): Message =>
    ({
      id: "test-msg-id",
      date: new Date().toISOString(),
      message_type: "approval_request_message",
      ...overrides,
    }) as unknown as Message;

  test("extracts single tool call from tool_calls array", () => {
    const msg = createMessage({
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "Bash",
          arguments: '{"command": "echo hello"}',
        },
      ],
    });

    const result = extractApprovals(msg);

    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-1");
    expect(result.pendingApprovals[0]?.toolName).toBe("Bash");
    expect(result.pendingApproval?.toolCallId).toBe("call-1");
  });

  test("extracts multiple parallel tool calls", () => {
    const msg = createMessage({
      tool_calls: [
        {
          tool_call_id: "call-1",
          name: "Bash",
          arguments: '{"command": "echo hello"}',
        },
        {
          tool_call_id: "call-2",
          name: "web_search",
          arguments: '{"query": "test"}',
        },
        {
          tool_call_id: "call-3",
          name: "Read",
          arguments: '{"file_path": "/tmp/test.txt"}',
        },
      ],
    });

    const result = extractApprovals(msg);

    expect(result.pendingApprovals).toHaveLength(3);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-1");
    expect(result.pendingApprovals[0]?.toolName).toBe("Bash");
    expect(result.pendingApprovals[1]?.toolCallId).toBe("call-2");
    expect(result.pendingApprovals[1]?.toolName).toBe("web_search");
    expect(result.pendingApprovals[2]?.toolCallId).toBe("call-3");
    expect(result.pendingApprovals[2]?.toolName).toBe("Read");
    // pendingApproval is deprecated, should be first item
    expect(result.pendingApproval?.toolCallId).toBe("call-1");
  });

  test("handles deprecated single tool_call field", () => {
    const msg = createMessage({
      tool_call: {
        tool_call_id: "call-legacy",
        name: "Write",
        arguments: '{"file_path": "/tmp/out.txt"}',
      },
    });

    const result = extractApprovals(msg);

    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-legacy");
    expect(result.pendingApprovals[0]?.toolName).toBe("Write");
  });

  test("prefers tool_calls array over deprecated tool_call", () => {
    const msg = createMessage({
      tool_calls: [{ tool_call_id: "call-new", name: "Bash", arguments: "{}" }],
      tool_call: {
        tool_call_id: "call-old",
        name: "Write",
        arguments: "{}",
      },
    });

    const result = extractApprovals(msg);

    // Should use tool_calls, not tool_call
    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-new");
  });

  test("filters out tool calls without tool_call_id", () => {
    const msg = createMessage({
      tool_calls: [
        { tool_call_id: "call-valid", name: "Bash", arguments: "{}" },
        { name: "Invalid", arguments: "{}" }, // Missing tool_call_id
        { tool_call_id: "", name: "Empty", arguments: "{}" }, // Empty tool_call_id
        { tool_call_id: "call-valid-2", name: "Read", arguments: "{}" },
      ],
    });

    const result = extractApprovals(msg);

    // Should only include entries with valid tool_call_id
    expect(result.pendingApprovals).toHaveLength(2);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-valid");
    expect(result.pendingApprovals[1]?.toolCallId).toBe("call-valid-2");
  });

  test("returns empty array when no tool calls present", () => {
    const msg = createMessage({});

    const result = extractApprovals(msg);

    expect(result.pendingApprovals).toHaveLength(0);
    expect(result.pendingApproval).toBeNull();
  });

  test("handles missing name and arguments gracefully", () => {
    const msg = createMessage({
      tool_calls: [{ tool_call_id: "call-minimal" }],
    });

    const result = extractApprovals(msg);

    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolCallId).toBe("call-minimal");
    expect(result.pendingApprovals[0]?.toolName).toBe("");
    expect(result.pendingApprovals[0]?.toolArgs).toBe("");
  });
});

/**
 * Tests for extractConflictDetail - shared error-text extraction from APIError shapes.
 * Replaces duplicated inline extraction in App.tsx and headless.ts.
 */
describe("extractConflictDetail", () => {
  test("extracts detail from nested error shape (e.error.error.detail)", () => {
    // This is the exact error shape from the interrupt→CONFLICT screenshot
    const error = {
      error: {
        error: {
          message_type: "error_message",
          error_type: "internal_error",
          message: "An unknown error occurred with the LLM streaming request.",
          detail:
            "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.",
        },
        run_id: "run-d056a979-dd6e-481c-86c1-9ca1da8f618c",
      },
    };
    const detail = extractConflictDetail(error);
    expect(detail).toBe(
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.",
    );
    // Extracted detail should route correctly through the classifier
    expect(isApprovalPendingError(detail)).toBe(true);
  });

  test("falls back to nested message when detail is missing", () => {
    const error = {
      error: {
        error: {
          message: "An unknown error with approval waiting for approval",
        },
      },
    };
    expect(extractConflictDetail(error)).toBe(
      "An unknown error with approval waiting for approval",
    );
  });

  test("extracts from flat shape (e.error.detail)", () => {
    const error = {
      error: {
        detail:
          "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.",
      },
    };
    const detail = extractConflictDetail(error);
    expect(isConversationBusyError(detail)).toBe(true);
  });

  test("extracts from flat shape (e.error.message) when detail is missing", () => {
    const error = {
      error: { message: "Agent is waiting for approval on tool call" },
    };
    const detail = extractConflictDetail(error);
    expect(detail).toBe("Agent is waiting for approval on tool call");
  });

  test("falls back to Error.message", () => {
    const error = new Error("Connection refused");
    expect(extractConflictDetail(error)).toBe("Connection refused");
  });

  test("returns empty string for non-error input", () => {
    expect(extractConflictDetail(null)).toBe("");
    expect(extractConflictDetail("string")).toBe("");
    expect(extractConflictDetail(42)).toBe("");
  });
});

/**
 * Tests for rebuildInputWithFreshDenials - strips stale approval payloads
 * from the currentInput array and optionally prepends fresh denial results.
 */
describe("rebuildInputWithFreshDenials", () => {
  test("strips stale approval and prepends fresh denials", () => {
    const input = [
      {
        type: "approval" as const,
        approvals: [
          {
            type: "tool" as const,
            tool_call_id: "stale-id",
            tool_return: "Interrupted by user",
            status: "error" as const,
          },
        ],
      },
      { type: "message" as const, role: "user" as const, content: "hello" },
    ];
    const serverApprovals = [
      { toolCallId: "real-id", toolName: "Read", toolArgs: "{}" },
    ];

    const result = rebuildInputWithFreshDenials(
      input,
      serverApprovals,
      "Auto-denied",
    );

    // Stale approval stripped, fresh denial prepended, message preserved
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("approval");
    const approvalPayload = result[0] as {
      type: "approval";
      approvals: Array<{
        tool_call_id: string;
        approve: boolean;
        reason: string;
      }>;
    };
    expect(approvalPayload.approvals[0]!.tool_call_id).toBe("real-id");
    expect(approvalPayload.approvals[0]!.approve).toBe(false);
    expect(approvalPayload.approvals[0]!.reason).toBe("Auto-denied");
    expect(result[1]!.type).toBe("message");
  });

  test("strips stale approval with no server approvals (clean retry)", () => {
    const input = [
      { type: "approval" as const, approvals: [] },
      { type: "message" as const, role: "user" as const, content: "hello" },
    ];

    const result = rebuildInputWithFreshDenials(input, [], "");

    // Only message remains
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe("message");
  });

  test("prepends fresh denials when no stale approvals to strip", () => {
    const input = [
      { type: "message" as const, role: "user" as const, content: "hello" },
    ];
    const serverApprovals = [
      { toolCallId: "real-id", toolName: "Read", toolArgs: "{}" },
    ];

    const result = rebuildInputWithFreshDenials(
      input,
      serverApprovals,
      "Auto-denied",
    );

    // Fresh denial prepended, message preserved
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("approval");
    expect(result[1]!.type).toBe("message");
  });

  test("handles multiple stale approvals and multiple server approvals", () => {
    const input = [
      {
        type: "approval" as const,
        approvals: [
          {
            type: "approval" as const,
            tool_call_id: "old-1",
            approve: false,
            reason: "stale",
          },
        ],
      },
      {
        type: "approval" as const,
        approvals: [
          {
            type: "approval" as const,
            tool_call_id: "old-2",
            approve: false,
            reason: "stale",
          },
        ],
      },
      { type: "message" as const, role: "user" as const, content: "hello" },
    ];
    const serverApprovals = [
      { toolCallId: "new-1", toolName: "Bash", toolArgs: "{}" },
      { toolCallId: "new-2", toolName: "Write", toolArgs: "{}" },
    ];

    const result = rebuildInputWithFreshDenials(
      input,
      serverApprovals,
      "denied",
    );

    // Both stale approvals stripped, one fresh denial payload prepended, message kept
    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("approval");
    const approvalPayload = result[0] as {
      type: "approval";
      approvals: Array<{ tool_call_id: string }>;
    };
    expect(approvalPayload.approvals).toHaveLength(2);
    expect(approvalPayload.approvals[0]!.tool_call_id).toBe("new-1");
    expect(approvalPayload.approvals[1]!.tool_call_id).toBe("new-2");
    expect(result[1]!.type).toBe("message");
  });
});

/**
 * Note: Full integration testing of lazy approval recovery requires:
 * 1. Starting CLI without --yolo
 * 2. Sending a prompt that triggers a tool call requiring approval
 * 3. Instead of approving, sending another user message
 * 4. Verifying the CONFLICT error is detected and recovery happens
 *
 * This is complex to automate reliably in unit tests.
 * Manual testing or a dedicated integration test suite is recommended.
 */
