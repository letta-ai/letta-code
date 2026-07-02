import { describe, expect, test } from "bun:test";
import {
  CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE,
  CHANNEL_LIFECYCLE_CONVERSATION_BUSY_TITLE,
  CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
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
      "View agent: \x1b]8;;https://app.letta.com/chat/agent-1?conversation=conv-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-123)",
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
      "View agent: \x1b]8;;https://app.letta.com/chat/agent-1\x1b\\agent-1\x1b]8;;\x1b\\ (run: run-abc)";

    expect(sanitizeChannelLifecycleErrorText(rawError)).toBe(
      "Usage limit reached.",
    );
    expect(extractChannelLifecycleRunId(rawError)).toBe("run-abc");
  });
});
