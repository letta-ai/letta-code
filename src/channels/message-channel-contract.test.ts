import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";

describe("MessageChannel contracts", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearChannelAccountStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
  });

  test("sends Discord direct routes to the DM channel without caller threadId", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "discord-msg-1" }));

    const adapter: ChannelAdapter = {
      id: "discord:discord-1",
      channelId: "discord",
      accountId: "discord-1",
      name: "Discord",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("discord", {
      accountId: "discord-1",
      chatId: "DM-123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "discord",
      chat_id: "DM-123",
      message: "hello dm",
      threadId: "",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to discord");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "discord-1",
      chatId: "DM-123",
      text: "hello dm",
      replyToMessageId: undefined,
      threadId: "DM-123",
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: undefined,
    });
  });

  test("rejects legacy argument aliases so the tool contract stays canonical", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "slack-msg-3" }));

    const adapter: ChannelAdapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("slack", {
      accountId: "account-1",
      chatId: "D123",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "D123",
      // @ts-expect-error intentionally asserting that legacy aliases are rejected at runtime too
      text: "hello from legacy args",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe("Error: Slack send requires message or media.");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("requires exactly one of chat_id or target", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "slack-msg-4" }));

    const adapter: ChannelAdapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "D123",
      target: "#eng",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe(
      "Error: MessageChannel requires exactly one of chat_id or target.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("handles ask action through the shared path for a sibling channel", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "discord-msg-ask" }));

    const adapter: ChannelAdapter = {
      id: "discord:discord-1",
      channelId: "discord",
      accountId: "discord-1",
      name: "Discord",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("discord", {
      accountId: "discord-1",
      chatId: "DM-456",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const question = {
      question: "Deploy to staging or production?",
      header: "Target",
      options: [
        { label: "staging", description: "Deploy to staging" },
        { label: "production", description: "Deploy to production" },
      ],
      multiSelect: false,
    };

    const pendingResult = await message_channel({
      action: "ask",
      channel: "discord",
      chat_id: "DM-456",
      questions: [question],
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(pendingResult).toBe("Waiting for user response...");
    expect(sendMessage).not.toHaveBeenCalled();

    const answeredResult = await message_channel({
      action: "ask",
      channel: "discord",
      chat_id: "DM-456",
      questions: [question],
      answers: { "Deploy to staging or production?": "staging" },
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(answeredResult).toContain("User has answered your questions");
    expect(answeredResult).toContain(
      '"Deploy to staging or production?"="staging"',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
