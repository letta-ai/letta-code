import { describe, expect, test } from "bun:test";

import {
  CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
  normalizeChannelLifecycleErrorMessage,
} from "./lifecycleError";

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

  test("uses the fallback for blank lifecycle details", () => {
    expect(normalizeChannelLifecycleErrorMessage("   ")).toBe(
      CHANNEL_LIFECYCLE_FALLBACK_ERROR_MESSAGE,
    );
  });
});
