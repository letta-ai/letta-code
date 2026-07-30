import { describe, expect, test } from "bun:test";
import {
  CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE,
  CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE,
  CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
  CHANNEL_LIFECYCLE_TRANSIENT_ERROR_MESSAGE,
  extractChannelLifecycleRunId,
  formatChannelLifecycleErrorMessage,
  normalizeChannelLifecycleErrorMessage,
  sanitizeChannelLifecycleErrorText,
} from "./lifecycle-error";

describe("normalizeChannelLifecycleErrorMessage", () => {
  test("keeps useful lifecycle details", () => {
    expect(
      normalizeChannelLifecycleErrorMessage(
        "  ChatGPT usage limit reached. Resets at 1:00 PM.  ",
      ),
    ).toBe("ChatGPT usage limit reached. Resets at 1:00 PM.");
  });

  test("replaces raw generic loop errors with a stable user-facing fallback", () => {
    expect(
      normalizeChannelLifecycleErrorMessage("Unexpected stop reason: error"),
    ).toBe(CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE);
  });

  test.each([
    ["raw Postgres lock timeout", "canceling statement due to lock timeout"],
    [
      "SQLAlchemy psycopg lock timeout",
      [
        "sqlalchemy.exc.OperationalError: (psycopg.errors.LockNotAvailable) canceling statement due to lock timeout",
        "[SQL: UPDATE steps SET status=$1 WHERE steps.id = $2]",
        "(Background on this error at: https://sqlalche.me/e/20/e3q8)",
      ].join("\n"),
    ],
    [
      "SQLSTATE 55P03 context",
      'psycopg.errors.LockNotAvailable: could not obtain lock on row in relation "steps" SQLSTATE: 55P03',
    ],
  ])(
    "replaces %s details with transient retry guidance",
    (_label, rawError) => {
      const message = normalizeChannelLifecycleErrorMessage(rawError);

      expect(message).toBe(CHANNEL_LIFECYCLE_TRANSIENT_ERROR_MESSAGE);
      expect(message).not.toContain("database");
      expect(message).not.toContain("lock");
      expect(message).not.toContain("55P03");
      expect(message).not.toContain("canceling statement");
      expect(message).not.toContain("steps");
    },
  );

  test("keeps ordinary non-Postgres lock timeout details", () => {
    expect(
      normalizeChannelLifecycleErrorMessage(
        "File lock timeout: /tmp/local.lock",
      ),
    ).toBe("File lock timeout: /tmp/local.lock");
  });

  test("replaces stuck approval conflicts with channel-safe guidance", () => {
    expect(
      normalizeChannelLifecycleErrorMessage(
        JSON.stringify({
          error: {
            error: {
              type: "internal_error",
              message:
                "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.",
              detail:
                "CONFLICT: Cannot send a new message: The agent is waiting for approval on a tool call. Please approve or deny the pending request before continuing.",
            },
            run_id: "run-123",
          },
        }),
      ),
    ).toBe(CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE);
  });

  test("uses the fallback for blank lifecycle details", () => {
    expect(normalizeChannelLifecycleErrorMessage("   ")).toBe(
      CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
    );
  });
});

describe("formatChannelLifecycleErrorMessage", () => {
  test("formats conversation busy conflicts without terminal links or app URLs", () => {
    const rawError = [
      JSON.stringify({
        error: {
          detail:
            "CONFLICT: Cannot send a new message: Another request is currently being processed for this conversation.",
          run_id: "run-123",
        },
      }),
      "View agent: \x1b]8;;https://chat.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-123)",
    ].join("\n");

    const message = formatChannelLifecycleErrorMessage(rawError);

    expect(message).toBe(
      `${CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE}\n` +
        "Another request is already processing for this conversation. Please wait for it to finish, then try again.\n\n" +
        "Run ID: run-123",
    );
    expect(message).not.toContain("app.letta.com");
    expect(message).not.toContain("\x1b");
  });

  test("can use automatic retry copy when a surface is actually retrying", () => {
    expect(
      formatChannelLifecycleErrorMessage(
        "Cannot send a new message: Another request is currently being processed for this conversation.",
        { automaticRetry: true },
      ),
    ).toBe(
      `${CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE}\n` +
        "Another request is already processing for this conversation. I’ll wait for it to finish and retry automatically.",
    );
  });

  test("code block formatting is skipped for conversation-busy guidance", () => {
    expect(
      formatChannelLifecycleErrorMessage(
        "Cannot send a new message: Another request is currently being processed for this conversation.",
        { codeBlock: true },
      ),
    ).not.toContain("```");
  });

  test("formats transient guidance without database internals", () => {
    const message = formatChannelLifecycleErrorMessage(
      "sqlalchemy.exc.OperationalError: SQLSTATE: 55P03 while updating steps",
      { codeBlock: true, runId: "run-47960fe9" },
    );

    expect(message).toBe(
      "Turn failed:\n" +
        `${CHANNEL_LIFECYCLE_TRANSIENT_ERROR_MESSAGE}\n\n` +
        "Run ID: run-47960fe9",
    );
    expect(message).not.toContain("```");
    expect(message).not.toContain("55P03");
    expect(message).not.toContain("steps");
  });

  test("appends explicit run IDs to generic channel errors", () => {
    expect(
      formatChannelLifecycleErrorMessage("Unexpected stop reason: error", {
        codeBlock: true,
        runId: "run-456",
      }),
    ).toBe(
      "Turn failed:\n" +
        "```\n" +
        "Something went wrong while processing that message. Please try again.\n" +
        "```\n\n" +
        "Run ID: run-456",
    );
  });
});

describe("sanitizeChannelLifecycleErrorText", () => {
  test("removes terminal hyperlink lines from generic channel errors", () => {
    const rawError =
      "Usage limit reached.\n" +
      "View agent: \x1b]8;;https://chat.letta.com/chat/agent-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-abc)";

    expect(sanitizeChannelLifecycleErrorText(rawError)).toBe(
      "Usage limit reached.",
    );
    expect(extractChannelLifecycleRunId(rawError)).toBe("run-abc");
  });
});
