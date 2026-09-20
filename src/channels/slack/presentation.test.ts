import { expect, test } from "bun:test";
import { buildSlackChatFootnote } from "./presentation";

test("buildSlackChatFootnote matches the Cloud Slack gateway footer when the model is known", () => {
  expect(
    buildSlackChatFootnote({
      agentId: "agent-1",
      conversationId: "conversation-1",
      modelHandle: "anthropic/claude-fable-5-1[1m]",
    }),
  ).toBe(
    "claude-fable-5-1[1m] · <https://chat.letta.com/chat/agent-1/connections/slack|Configure> · <https://chat.letta.com/chat/agent-1?conversation=conversation-1|View>",
  );
});

test("buildSlackChatFootnote escapes mrkdwn metacharacters in the model name", () => {
  expect(
    buildSlackChatFootnote({
      agentId: "agent-1",
      conversationId: "conv-1",
      modelHandle: "provider/a&b<x>",
    }),
  ).toContain("a&amp;b&lt;x&gt;");
});

test("buildSlackChatFootnote falls back to View on web without a model", () => {
  expect(
    buildSlackChatFootnote({
      agentId: "agent-1",
      conversationId: "conv-1",
    }),
  ).toBe(
    "<https://chat.letta.com/chat/agent-1?conversation=conv-1|View on web>",
  );
  expect(
    buildSlackChatFootnote({
      agentId: "agent-1",
      conversationId: "default",
      modelHandle: null,
    }),
  ).toBe("<https://chat.letta.com/chat/agent-1|View on web>");
});

test("buildSlackChatFootnote omits the footer for local agents", () => {
  expect(
    buildSlackChatFootnote({
      agentId: "agent-local-1",
      conversationId: "conv-1",
      modelHandle: "kimi-k3",
    }),
  ).toBe("");
});
