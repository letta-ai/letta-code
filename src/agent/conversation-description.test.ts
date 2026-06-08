import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import {
  buildConversationDescriptionMessages,
  normalizeConversationDescription,
} from "@/agent/conversation-description";

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

describe("buildConversationDescriptionMessages", () => {
  test("keeps user and assistant text in transcript order", () => {
    const messages = [
      {
        message_type: "user_message",
        content: [{ type: "text", text: "please inspect the traces" }],
      },
      {
        message_type: "reasoning_message",
        reasoning: "hidden thinking",
      },
      {
        message_type: "assistant_message",
        content: [{ type: "text", text: "the p95 is cooked" }],
      },
    ] as Message[];

    expect(buildConversationDescriptionMessages(messages)).toEqual([
      { role: "user", content: "please inspect the traces" },
      { role: "assistant", content: "the p95 is cooked" },
    ]);
  });
});
