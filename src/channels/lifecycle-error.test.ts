import { describe, expect, test } from "bun:test";

import {
  CHANNEL_LIFECYCLE_APPROVAL_PENDING_MESSAGE,
  CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
  normalizeChannelLifecycleErrorMessage,
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
