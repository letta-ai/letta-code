import { describe, expect, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import {
  resolveMessageChannelTurnSource,
  resolveUniqueChannelTurnSource,
} from "./message-channel-source";
import type { NormalizedMessageChannelInput } from "./message-channel-types";

function messageInput(
  overrides: Partial<NormalizedMessageChannelInput> = {},
): NormalizedMessageChannelInput {
  return {
    action: "send",
    channel: "source-aware",
    chatId: "chat-1",
    threadId: null,
    message: "hello",
    ...overrides,
  };
}

function turnSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "source-aware",
    accountId: "account-1",
    chatId: "chat-1",
    chatType: "channel",
    senderId: "sender-1",
    senderTeamId: "team-1",
    messageId: "message-1",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conversation-1",
    ...overrides,
  };
}

const scope = { agentId: "agent-1", conversationId: "conversation-1" };

describe("MessageChannel turn source resolution", () => {
  test("collapses identical source copies", () => {
    const source = turnSource();

    expect(
      resolveUniqueChannelTurnSource({
        input: messageInput(),
        scope,
        accountId: "account-1",
        threadId: null,
        channelTurnSources: [source, { ...source }],
      }),
    ).toEqual(source);
  });

  test("fails closed for conflicting matching sources", () => {
    expect(
      resolveUniqueChannelTurnSource({
        input: messageInput(),
        scope,
        accountId: "account-1",
        threadId: null,
        channelTurnSources: [
          turnSource(),
          turnSource({ senderId: "sender-2" }),
        ],
      }),
    ).toBeUndefined();
  });

  test("preserves provenance when Slack infers a root thread", () => {
    const source = turnSource({
      channel: "slack",
      chatId: "C123",
      messageId: "1712790000.000050",
    });

    expect(
      resolveMessageChannelTurnSource({
        input: messageInput({ channel: "slack", chatId: "C123" }),
        scope,
        accountId: "account-1",
        routeThreadId: null,
        channelTurnSources: [source],
      }),
    ).toEqual({
      threadId: "1712790000.000050",
      source,
    });
  });
});
