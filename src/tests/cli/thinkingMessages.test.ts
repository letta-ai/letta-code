import { describe, expect, test } from "bun:test";
import { getRandomThinkingMessage } from "../../cli/helpers/thinkingMessages";

describe("Thinking messages", () => {
  test("returns formatted message with agent name", () => {
    const message = getRandomThinkingMessage("Letta");
    
    // Should be in format "Letta is <verb>ing"
    expect(message).toMatch(/^Letta is \w+$/);
    expect(message.startsWith("Letta is ")).toBe(true);
  });

  test("returns capitalized verb without agent name", () => {
    const message = getRandomThinkingMessage();
    
    // Should be a capitalized verb (e.g., "Thinking", "Processing")
    expect(message).toMatch(/^[A-Z][a-z]+$/);
    expect(message[0]).toMatch(/[A-Z]/);
  });

  test("handles null agent name", () => {
    const message = getRandomThinkingMessage(null);
    
    // Should fall back to capitalized verb
    expect(message).toMatch(/^[A-Z][a-z]+$/);
  });

  test("handles empty string agent name", () => {
    const message = getRandomThinkingMessage("");
    
    // Should fall back to capitalized verb (empty string is falsy)
    expect(message).toMatch(/^[A-Z][a-z]+$/);
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
