import { describe, expect, test } from "bun:test";
import {
  classifyPreStreamConflict,
  extractConflictDetail,
  getPreStreamErrorAction,
  isApprovalPendingError,
  isConversationBusyError,
  isInvalidToolCallIdsError,
  isNonRetryableProviderErrorDetail,
  isRetryableProviderErrorDetail,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  shouldAttemptApprovalRecovery,
  shouldRetryPreStreamTransientError,
  shouldRetryRunMetadataError,
} from "../agent/turn-recovery-policy";

// ── Classifier parity ───────────────────────────────────────────────

describe("isApprovalPendingError", () => {
  test("detects real CONFLICT error", () => {
    expect(
      isApprovalPendingError(
        "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.",
      ),
    ).toBe(true);
  });

  test("case insensitive", () => {
    expect(isApprovalPendingError("WAITING FOR APPROVAL")).toBe(true);
  });

  test("does not match conversation-busy", () => {
    expect(
      isApprovalPendingError(
        "CONFLICT: Another request is currently being processed",
      ),
    ).toBe(false);
  });

  test("rejects non-string", () => {
    expect(isApprovalPendingError(42)).toBe(false);
    expect(isApprovalPendingError(null)).toBe(false);
  });
});

describe("isConversationBusyError", () => {
  test("detects real busy error", () => {
    expect(
      isConversationBusyError(
        "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.",
      ),
    ).toBe(true);
  });

  test("rejects approval-pending", () => {
    expect(isConversationBusyError("The agent is waiting for approval")).toBe(
      false,
    );
  });
});

describe("isInvalidToolCallIdsError", () => {
  test("detects ID mismatch", () => {
    expect(
      isInvalidToolCallIdsError(
        "Invalid tool call IDs: Expected ['tc_abc'], got ['tc_xyz']",
      ),
    ).toBe(true);
  });

  test("rejects unrelated", () => {
    expect(isInvalidToolCallIdsError("Connection refused")).toBe(false);
  });
});

// ── Pre-stream conflict routing ─────────────────────────────────────

describe("classifyPreStreamConflict", () => {
  test("approval pending", () => {
    expect(
      classifyPreStreamConflict("waiting for approval on a tool call"),
    ).toBe("approval_pending");
  });

  test("conversation busy", () => {
    expect(
      classifyPreStreamConflict("another request is currently being processed"),
    ).toBe("conversation_busy");
  });

  test("unknown", () => {
    expect(classifyPreStreamConflict("Connection refused")).toBeNull();
  });
});

describe("getPreStreamErrorAction", () => {
  test("approval pending → resolve", () => {
    expect(getPreStreamErrorAction("waiting for approval", 0, 3)).toBe(
      "resolve_approval_pending",
    );
  });

  test("conversation busy with budget → retry", () => {
    expect(
      getPreStreamErrorAction(
        "another request is currently being processed",
        0,
        3,
      ),
    ).toBe("retry_conversation_busy");
  });

  test("conversation busy, budget exhausted → rethrow", () => {
    expect(
      getPreStreamErrorAction(
        "another request is currently being processed",
        3,
        3,
      ),
    ).toBe("rethrow");
  });

  test("unknown error → rethrow", () => {
    expect(getPreStreamErrorAction("Connection refused", 0, 3)).toBe("rethrow");
  });

  test("transient 5xx with retry budget → retry_transient", () => {
    expect(
      getPreStreamErrorAction(
        "ChatGPT server error: upstream connect error",
        0,
        1,
        {
          status: 502,
          transientRetries: 0,
          maxTransientRetries: 3,
        },
      ),
    ).toBe("retry_transient");
  });

  test("transient retry budget exhausted → rethrow", () => {
    expect(
      getPreStreamErrorAction("Connection error during streaming", 0, 1, {
        transientRetries: 3,
        maxTransientRetries: 3,
      }),
    ).toBe("rethrow");
  });

  // Parity: TUI and headless both pass the same (detail, retries, max) triple
  // to this function — verifying the action is deterministic from those inputs.
  test("same inputs always produce same action (determinism)", () => {
    const detail =
      "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.";
    const a = getPreStreamErrorAction(detail, 1, 3);
    const b = getPreStreamErrorAction(detail, 1, 3);
    expect(a).toBe(b);
    expect(a).toBe("resolve_approval_pending");
  });
});

describe("provider detail retry helpers", () => {
  test("detects retryable ChatGPT transient patterns", () => {
    expect(
      isRetryableProviderErrorDetail(
        "ChatGPT server error: upstream connect error or disconnect/reset before headers",
      ),
    ).toBe(true);
    expect(
      isRetryableProviderErrorDetail(
        "Connection error during streaming: incomplete chunked read",
      ),
    ).toBe(true);
  });

  test("detects non-retryable auth patterns", () => {
    expect(
      isNonRetryableProviderErrorDetail("OpenAI API error: invalid API key"),
    ).toBe(true);
    expect(isNonRetryableProviderErrorDetail("Error code: 401")).toBe(true);
  });

  test("run metadata retry classification respects llm_error + non-retryable", () => {
    expect(
      shouldRetryRunMetadataError(
        "llm_error",
        "ChatGPT server error: upstream connect error",
      ),
    ).toBe(true);
    expect(
      shouldRetryRunMetadataError(
        "llm_error",
        "OpenAI API error: invalid_request_error",
      ),
    ).toBe(false);
  });

  test("pre-stream transient classifier handles status and detail", () => {
    expect(
      shouldRetryPreStreamTransientError({
        status: 503,
        detail: "server error",
      }),
    ).toBe(true);
    expect(
      shouldRetryPreStreamTransientError({
        status: 429,
        detail: "rate limited",
      }),
    ).toBe(true);
    expect(
      shouldRetryPreStreamTransientError({
        status: 401,
        detail: "unauthorized",
      }),
    ).toBe(false);
    expect(
      shouldRetryPreStreamTransientError({
        status: undefined,
        detail: "Connection error during streaming",
      }),
    ).toBe(true);
  });
});

describe("parseRetryAfterHeaderMs", () => {
  test("parses delta seconds", () => {
    expect(parseRetryAfterHeaderMs("2")).toBe(2000);
  });

  test("returns null for invalid header", () => {
    expect(parseRetryAfterHeaderMs("not-a-date")).toBeNull();
  });
});

// ── Error text extraction ───────────────────────────────────────────

describe("extractConflictDetail", () => {
  test("nested: e.error.error.detail", () => {
    const err = {
      error: {
        error: {
          detail: "CONFLICT: waiting for approval",
          message: "generic",
        },
      },
    };
    expect(extractConflictDetail(err)).toBe("CONFLICT: waiting for approval");
  });

  test("nested: falls back to e.error.error.message", () => {
    const err = { error: { error: { message: "fallback msg" } } };
    expect(extractConflictDetail(err)).toBe("fallback msg");
  });

  test("flat: e.error.detail", () => {
    const err = {
      error: { detail: "another request is currently being processed" },
    };
    expect(extractConflictDetail(err)).toBe(
      "another request is currently being processed",
    );
  });

  test("flat: e.error.message", () => {
    const err = { error: { message: "some error" } };
    expect(extractConflictDetail(err)).toBe("some error");
  });

  test("Error instance", () => {
    expect(extractConflictDetail(new Error("boom"))).toBe("boom");
  });

  test("non-error returns empty string", () => {
    expect(extractConflictDetail(null)).toBe("");
    expect(extractConflictDetail(42)).toBe("");
    expect(extractConflictDetail("string")).toBe("");
  });

  // Parity: same APIError shape from headless and TUI → same extracted text
  test("end-to-end: extraction feeds into classifier correctly", () => {
    const sdkError = {
      error: {
        error: {
          message_type: "error_message",
          error_type: "internal_error",
          message: "An unknown error occurred with the LLM streaming request.",
          detail:
            "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call.",
        },
        run_id: "run-abc",
      },
    };
    const detail = extractConflictDetail(sdkError);
    expect(isApprovalPendingError(detail)).toBe(true);
    expect(isConversationBusyError(detail)).toBe(false);
    expect(getPreStreamErrorAction(detail, 0, 3)).toBe(
      "resolve_approval_pending",
    );
  });
});

// ── Stale approval payload rewrite ──────────────────────────────────

describe("rebuildInputWithFreshDenials", () => {
  const userMsg = {
    type: "message" as const,
    role: "user" as const,
    content: "hello",
  };

  test("strips stale + prepends fresh denials", () => {
    const input = [
      {
        type: "approval" as const,
        approvals: [
          {
            type: "tool" as const,
            tool_call_id: "stale",
            tool_return: "Interrupted",
            status: "error" as const,
          },
        ],
      },
      userMsg,
    ];
    const result = rebuildInputWithFreshDenials(
      input,
      [{ toolCallId: "real", toolName: "Read", toolArgs: "{}" }],
      "denied",
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe("approval");
    expect(result[1]?.type).toBe("message");
  });

  test("no server approvals → strips only", () => {
    const input = [
      { type: "approval" as const, approvals: [] as never[] },
      userMsg,
    ];
    const result = rebuildInputWithFreshDenials(input, [], "");
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("message");
  });

  test("no stale approvals → prepends fresh", () => {
    const result = rebuildInputWithFreshDenials(
      [userMsg],
      [{ toolCallId: "new", toolName: "Bash", toolArgs: "{}" }],
      "auto-denied",
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.type).toBe("approval");
    expect(result[1]?.type).toBe("message");
  });
});

// ── Retry gating ────────────────────────────────────────────────────

describe("shouldAttemptApprovalRecovery", () => {
  test("true when detected and under budget", () => {
    expect(
      shouldAttemptApprovalRecovery({
        approvalPendingDetected: true,
        retries: 0,
        maxRetries: 3,
      }),
    ).toBe(true);
  });

  test("true at boundary (retries < max)", () => {
    expect(
      shouldAttemptApprovalRecovery({
        approvalPendingDetected: true,
        retries: 2,
        maxRetries: 3,
      }),
    ).toBe(true);
  });

  test("false when budget exhausted (retries === max)", () => {
    expect(
      shouldAttemptApprovalRecovery({
        approvalPendingDetected: true,
        retries: 3,
        maxRetries: 3,
      }),
    ).toBe(false);
  });

  test("false when over budget", () => {
    expect(
      shouldAttemptApprovalRecovery({
        approvalPendingDetected: true,
        retries: 5,
        maxRetries: 3,
      }),
    ).toBe(false);
  });

  test("false when not detected", () => {
    expect(
      shouldAttemptApprovalRecovery({
        approvalPendingDetected: false,
        retries: 0,
        maxRetries: 3,
      }),
    ).toBe(false);
  });

  // Parity: TUI uses llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
  // headless uses llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES
  // Both should produce the same result for the same inputs.
  test("parity: same inputs → same decision regardless of caller", () => {
    const tuiResult = shouldAttemptApprovalRecovery({
      approvalPendingDetected: true,
      retries: 1,
      maxRetries: 3,
    });
    const headlessResult = shouldAttemptApprovalRecovery({
      approvalPendingDetected: true,
      retries: 1,
      maxRetries: 3,
    });
    expect(tuiResult).toBe(headlessResult);
  });
});
