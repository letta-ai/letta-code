import { describe, expect, test } from "bun:test";
import type { LocalAssistantMessage } from "./local-message";
import { projectLocalMessageToStoredMessages } from "./local-message-projection";

function assistantMessage(
  content: LocalAssistantMessage["content"],
): LocalAssistantMessage {
  return {
    id: "ui-msg-1",
    role: "assistant",
    content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

describe("projectLocalMessageToStoredMessages", () => {
  test("groups adjacent thinking content into one reasoning message", () => {
    const message = assistantMessage([
      {
        type: "thinking",
        thinking: "First summary",
        thinkingSignature: "signature-1",
      },
      {
        type: "thinking",
        thinking: "Second summary",
        thinkingSignature: "signature-2",
      },
    ]);

    const projected = projectLocalMessageToStoredMessages(
      message,
      "agent-1",
      "conversation-1",
      "2026-07-12T00:00:00.000Z",
    );

    expect(projected).toEqual([
      expect.objectContaining({
        id: "ui-msg-1:reasoning:0",
        message_type: "reasoning_message",
        reasoning: "First summary\n\nSecond summary",
      }),
    ]);
    expect(message.content).toEqual([
      expect.objectContaining({ thinkingSignature: "signature-1" }),
      expect.objectContaining({ thinkingSignature: "signature-2" }),
    ]);
  });

  test("keeps reasoning groups separated by assistant text", () => {
    const projected = projectLocalMessageToStoredMessages(
      assistantMessage([
        { type: "thinking", thinking: "First thought" },
        { type: "text", text: "Interleaved answer" },
        { type: "thinking", thinking: "Second thought" },
      ]),
      "agent-1",
      "conversation-1",
      "2026-07-12T00:00:00.000Z",
    );

    expect(projected.map((message) => message.message_type)).toEqual([
      "reasoning_message",
      "assistant_message",
      "reasoning_message",
    ]);
    expect(projected.map((message) => message.id)).toEqual([
      "ui-msg-1:reasoning:0",
      "ui-msg-1:assistant:1",
      "ui-msg-1:reasoning:2",
    ]);
  });
});
