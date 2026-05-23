import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_TITLE_MAX_LENGTH,
  normalizeConversationTitle,
} from "@/cli/helpers/conversation-title";

describe("normalizeConversationTitle", () => {
  test("returns null for empty input", () => {
    expect(normalizeConversationTitle("")).toBeNull();
    expect(normalizeConversationTitle("   ")).toBeNull();
  });

  test("returns null for slash-command-shaped values", () => {
    expect(normalizeConversationTitle("/rename convo")).toBeNull();
    expect(normalizeConversationTitle("  /resume  ")).toBeNull();
  });

  test("collapses internal whitespace", () => {
    expect(normalizeConversationTitle("  Wire   up  fork  ")).toBe(
      "Wire up fork",
    );
  });

  test("strips a single layer of surrounding quotes", () => {
    expect(normalizeConversationTitle('"Refactor auth flow"')).toBe(
      "Refactor auth flow",
    );
    expect(normalizeConversationTitle("'Plan q4 roadmap'")).toBe(
      "Plan q4 roadmap",
    );
  });

  test("leaves mismatched / nested quotes alone", () => {
    expect(normalizeConversationTitle('"Title with "quoted" word"')).toBe(
      'Title with "quoted" word',
    );
  });

  test("truncates to CONVERSATION_TITLE_MAX_LENGTH", () => {
    const long = "a".repeat(CONVERSATION_TITLE_MAX_LENGTH + 50);
    const result = normalizeConversationTitle(long);
    expect(result).not.toBeNull();
    expect(result?.length).toBe(CONVERSATION_TITLE_MAX_LENGTH);
  });
});
