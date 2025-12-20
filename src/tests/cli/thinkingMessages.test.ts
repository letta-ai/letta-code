import { describe, expect, test } from "bun:test";
import { getRandomThinkingMessage } from "../../cli/helpers/thinkingMessages";

describe("Thinking messages", () => {
  test("returns formatted message with agent name", () => {
    const message = getRandomThinkingMessage("Letta");

    // Should be in format "Letta is <verb/phrase>"
    expect(message).toMatch(/^Letta is .+$/);
    expect(message.startsWith("Letta is ")).toBe(true);
  });

  test("returns capitalized verb without agent name", () => {
    const message = getRandomThinkingMessage();

    // Should be a capitalized verb/phrase (e.g., "Thinking", "Processing", "Absolutely right")
    expect(message).toMatch(/^[A-Z].+$/);
    expect(message[0]).toMatch(/[A-Z]/);
  });

  test("handles null agent name", () => {
    const message = getRandomThinkingMessage(null);

    // Should fall back to capitalized verb/phrase
    expect(message).toMatch(/^[A-Z].+$/);
  });

  test("handles empty string agent name", () => {
    const message = getRandomThinkingMessage("");

    // Should fall back to capitalized verb/phrase (empty string is falsy)
    expect(message).toMatch(/^[A-Z].+$/);
  });

  test("generates different messages on multiple calls", () => {
    const messages = new Set<string>();

    // Generate 10 messages, should get some variety
    for (let i = 0; i < 10; i++) {
      messages.add(getRandomThinkingMessage("Agent"));
    }

    // Should have more than 1 unique message (with high probability)
    expect(messages.size).toBeGreaterThan(1);
  });
});
