import { describe, expect, test } from "bun:test";
import {
  buildChannelTurnSource,
  buildOutboundChannelMessageFromTurnSource,
  formatBatchedChannelMessagesForAgent,
  formatInboundChannelMessageForAgent,
} from "@/channels/processor";
import type { ChannelRoute, InboundChannelMessage } from "@/channels/types";

describe("channel processor primitives", () => {
  test("builds channel turn source from an inbound message and route", () => {
    const message: InboundChannelMessage = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      senderId: "U123",
      senderTeamId: "T123",
      text: "hello",
      timestamp: 1_700_000_000_000,
      messageId: "1712790000.000050",
      threadId: "1712790000.000000",
      chatType: "channel",
    };
    const route: ChannelRoute = {
      accountId: "integration-1",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000000",
      agentId: "agent-1",
      conversationId: "conversation-1",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    expect(buildChannelTurnSource({ message, route })).toEqual({
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      chatType: "channel",
      senderId: "U123",
      senderTeamId: "T123",
      messageId: "1712790000.000050",
      threadId: "1712790000.000000",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
  });

  test("formats inbound channel messages with thread context", () => {
    const message: InboundChannelMessage = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      chatLabel: "#eng",
      senderId: "U123",
      senderName: "Shub",
      text: "current message",
      timestamp: Date.UTC(2026, 0, 1),
      messageId: "2",
      threadId: "1",
      chatType: "channel",
      threadContext: {
        label: "Slack thread",
        starter: {
          messageId: "1",
          senderId: "U456",
          senderName: "Alice",
          text: "starter",
        },
        history: [
          {
            messageId: "1.5",
            senderId: "U789",
            senderName: "Bob",
            text: "history",
          },
        ],
      },
    };

    expect(formatInboundChannelMessageForAgent({ message })).toBe(
      "--- Slack thread ---\n" +
        "starter: [Alice:U456]<1>:starter\n" +
        "[Bob:U789]<1.5>:history\n" +
        "--- End Thread Context ---\n\n" +
        "[slack:#eng][Shub:U123]<2026-01-01T00:00:00.000Z>:current message",
    );
  });

  test("formats batched channel messages without adding duplicate sender wrappers", () => {
    const text = formatBatchedChannelMessagesForAgent({
      messages: [
        {
          text: "[slack:#general][Ada:U123]<2026-01-01T00:00:00.000Z>:hello",
          channelTurnSource: {
            channel: "slack",
            chatId: "C123",
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        },
        {
          text: "[slack:#general][Bob:U456]<2026-01-01T00:00:01.000Z>:world",
          channelTurnSource: {
            channel: "slack",
            chatId: "C123",
            agentId: "agent-1",
            conversationId: "conv-1",
          },
        },
      ],
    });

    expect(text).toBe(
      "--- Batched Channel Messages (2) ---\n" +
        "[slack:#general][Ada:U123]<2026-01-01T00:00:00.000Z>:hello\n" +
        "[slack:#general][Bob:U456]<2026-01-01T00:00:01.000Z>:world\n" +
        "--- End Batched Channel Messages ---",
    );
  });

  test("builds outbound channel messages from turn source", () => {
    const source = {
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      threadId: "1700000000.000100",
      agentId: "agent-1",
      conversationId: "conv-1",
    };
    const message = buildOutboundChannelMessageFromTurnSource({
      turnSource: source,
      text: "response",
    });

    expect(message).toEqual({
      channel: "slack",
      accountId: "integration-1",
      chatId: "C123",
      threadId: "1700000000.000100",
      source,
      text: "response",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
  });
});
