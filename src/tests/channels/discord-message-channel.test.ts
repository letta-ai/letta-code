import { afterEach, describe, expect, mock, test } from "bun:test";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import { clearAllRoutes, setRouteInMemory } from "../../channels/routing";
import type { ChannelAdapter } from "../../channels/types";
import { message_channel } from "../../tools/impl/MessageChannel";

describe("message_channel (discord)", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
  });

  test("send routes through discord adapter", async () => {
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
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "discord",
      chat_id: "DM-123",
      message: "hello from Letta",
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
      text: "hello from Letta",
      replyToMessageId: undefined,
      threadId: null,
      parseMode: undefined,
    });
  });

  test("react routes through discord adapter", async () => {
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
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "react",
      channel: "discord",
      chat_id: "DM-123",
      emoji: "🔥",
      messageId: "msg-1",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("discord");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage.mock.calls as unknown[][])[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.reaction).toBe("🔥");
    expect(call.targetMessageId).toBe("msg-1");
  });

  test("upload-file routes through discord adapter", async () => {
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
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "discord",
      chat_id: "DM-123",
      media: "/tmp/photo.png",
      message: "check this",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("discord");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage.mock.calls as unknown[][])[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.mediaPath).toBe("/tmp/photo.png");
  });

  test("replies default to routed thread", async () => {
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
      threadId: "thread-abc",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    await message_channel({
      action: "send",
      channel: "discord",
      chat_id: "DM-123",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const call = (sendMessage.mock.calls as unknown[][])[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(call.threadId).toBe("thread-abc");
  });

  test("replyTo keeps the routed thread on discord sends", async () => {
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
      chatId: "channel-123",
      threadId: "thread-abc",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    await message_channel({
      action: "send",
      channel: "discord",
      chat_id: "channel-123",
      message: "hello",
      replyTo: "msg-42",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "discord",
      accountId: "discord-1",
      chatId: "channel-123",
      text: "hello",
      replyToMessageId: "msg-42",
      threadId: "thread-abc",
      parseMode: undefined,
    });
  });
});
