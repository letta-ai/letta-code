import { describe, expect, test } from "bun:test";
import { normalizeConversationDescription } from "@/agent/conversation-description";

describe("normalizeConversationDescription", () => {
  test("returns null for empty and slash-command-shaped values", () => {
    expect(normalizeConversationDescription("")).toBeNull();
    expect(normalizeConversationDescription("   ")).toBeNull();
    expect(normalizeConversationDescription("/compact all")).toBeNull();
  });

  test("collapses whitespace and strips surrounding quotes", () => {
    expect(
      normalizeConversationDescription(
        '  "Discussed   conversation   description metadata"  ',
      ),
    ).toBe("Discussed conversation description metadata");
  });

  test("trims to forty words", () => {
    const words = Array.from({ length: 45 }, (_, index) => `word${index}`);

    expect(normalizeConversationDescription(words.join(" "))).toBe(
      words.slice(0, 40).join(" "),
    );
  });
});
