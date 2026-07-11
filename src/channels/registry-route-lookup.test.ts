import { beforeEach, describe, expect, test } from "bun:test";
import {
  getRawRouteForInboundMessage,
  getRouteForInboundMessage,
} from "@/channels/registry-route-lookup";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";

const NOW = "2026-07-03T00:00:00.000Z";

beforeEach(() => {
  clearAllRoutes();
});

describe("registry route lookup", () => {
  test("falls Telegram private topics back to the root direct route", () => {
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
      enabled: true,
      createdAt: NOW,
    });

    expect(
      getRouteForInboundMessage({
        channel: "telegram",
        accountId: "telegram-bot",
        chatId: "123",
        chatType: "direct",
        threadId: "175380",
      }),
    ).toMatchObject({
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
    });
  });

  test("keeps exact Telegram topic routes authoritative", () => {
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
      enabled: true,
      createdAt: NOW,
    });
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: "175380",
      agentId: "agent-topic",
      conversationId: "conv-topic",
      enabled: true,
      createdAt: NOW,
    });

    expect(
      getRouteForInboundMessage({
        channel: "telegram",
        accountId: "telegram-bot",
        chatId: "123",
        chatType: "direct",
        threadId: "175380",
      }),
    ).toMatchObject({
      threadId: "175380",
      agentId: "agent-topic",
      conversationId: "conv-topic",
    });
  });

  test("does not bypass a disabled exact Telegram topic route", () => {
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
      enabled: true,
      createdAt: NOW,
    });
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: "175380",
      agentId: "agent-topic",
      conversationId: "conv-topic",
      enabled: false,
      createdAt: NOW,
    });

    const msg = {
      channel: "telegram",
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct" as const,
      threadId: "175380",
    };

    expect(getRouteForInboundMessage(msg)).toBeNull();
    expect(getRawRouteForInboundMessage(msg)).toMatchObject({
      threadId: "175380",
      enabled: false,
      agentId: "agent-topic",
      conversationId: "conv-topic",
    });
  });

  test("does not fall non-Telegram threads back to root routes", () => {
    setRouteInMemory("discord", {
      accountId: "discord-bot",
      chatId: "channel-1",
      chatType: "channel",
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
      enabled: true,
      createdAt: NOW,
    });

    expect(
      getRouteForInboundMessage({
        channel: "discord",
        accountId: "discord-bot",
        chatId: "channel-1",
        chatType: "channel",
        threadId: "thread-1",
      }),
    ).toBeNull();
  });
});
