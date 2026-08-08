import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "@/channels/targets";
import type { ChannelAdapter } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";

describe("MessageChannel Slack", () => {
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

  function installChannelStateTestOverrides(): void {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  }

  test("uses the routed account adapter for multi-account channels", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "slack-msg-1" }));

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
      message: "hello from Letta",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "D123",
      text: "hello from Letta",
      replyToMessageId: undefined,
      threadId: null,
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "default",
    });
  });

  test("does not infer Slack DM threads from flat active turn metadata", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "slack-dm-msg" }));

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
      channel: "slack",
      chat_id: "D123",
      message: "hello from DM",
      replyTo: "1712800000.000099",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
      channelTurnSources: [
        {
          channel: "slack",
          accountId: "account-1",
          chatId: "D123",
          chatType: "direct",
          messageId: "1712800000.000100",
          threadId: null,
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "D123",
      text: "hello from DM",
      replyToMessageId: undefined,
      threadId: null,
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "default",
    });
  });

  test("preserves explicit Slack DM threads from active turn metadata", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "slack-dm-thread-msg",
    }));

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
      chatType: "direct",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "D123",
      message: "hello from a DM thread",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
      channelTurnSources: [
        {
          channel: "slack",
          accountId: "account-1",
          chatId: "D123",
          chatType: "direct",
          messageId: "1712800000.000100",
          threadId: "1712790000.000050",
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "D123",
      text: "hello from a DM thread",
      replyToMessageId: undefined,
      threadId: "1712790000.000050",
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "default",
    });
  });

  test("defaults Slack replies back into the routed thread", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "slack-msg-2" }));

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
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-thread",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "C123",
      message: "hello from thread",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "C123",
      text: "hello from thread",
      replyToMessageId: undefined,
      threadId: "1712790000.000050",
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "conv-thread",
    });
  });

  test("inherits active Slack turn thread when route is channel-scoped", async () => {
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
      chatId: "C123",
      chatType: "channel",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-channel",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      chat_id: "C123",
      message: "hello from active turn",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-channel",
      },
      channelTurnSources: [
        {
          channel: "slack",
          accountId: "account-1",
          chatId: "C123",
          chatType: "channel",
          messageId: "1712790000.000050",
          threadId: "1712790000.000050",
          agentId: "agent-1",
          conversationId: "conv-channel",
        },
      ],
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "C123",
      text: "hello from active turn",
      replyToMessageId: undefined,
      threadId: "1712790000.000050",
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "conv-channel",
    });
  });

  test("passes Slack reactions through MessageChannel with the routed account", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "1712800000.000100" }));

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
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-thread",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "react",
      channel: "slack",
      chat_id: "C123",
      emoji: "white_check_mark",
      messageId: "1712800000.000100",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(result).toContain("Reaction added on slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "C123",
      text: "",
      replyToMessageId: undefined,
      targetMessageId: "1712800000.000100",
      reaction: "white_check_mark",
      removeReaction: undefined,
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      threadId: "1712790000.000050",
      parseMode: undefined,
    });
  });

  test("passes Slack file uploads through MessageChannel with the routed account", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "1712800000.000101" }));

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
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-thread",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "slack",
      chat_id: "C123",
      message: "release notes",
      media: "/tmp/release-notes.png",
      filename: "release-notes.png",
      title: "Release notes",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(result).toContain("Attachment sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "C123",
      text: "release notes",
      replyToMessageId: undefined,
      threadId: "1712790000.000050",
      mediaPath: "/tmp/release-notes.png",
      fileName: "release-notes.png",
      title: "Release notes",
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "conv-thread",
    });
  });

  test("downloads a scoped Slack attachment through the routed adapter", async () => {
    const registry = new ChannelRegistry();
    const downloadAttachment = mock(async () => ({
      id: "FLARGE",
      name: "LandscapeTransmission.zip",
      mimeType: "application/zip",
      sizeBytes: 43_714_492,
      kind: "file" as const,
      localPath:
        "/tmp/channels/slack/inbound/account-1/LandscapeTransmission.zip",
    }));
    const adapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "unused" }),
      sendDirectReply: async () => {},
      downloadAttachment,
    };

    registry.registerAdapter(adapter);
    setRouteInMemory("slack", {
      accountId: "account-1",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-thread",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "download-file",
      channel: "slack",
      chat_id: "C123",
      threadId: "1712790000.000050",
      attachmentId: "FLARGE",
      messageId: "1712800000.000100",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(result).toBe(
      "Slack attachment downloaded (local_path: /tmp/channels/slack/inbound/account-1/LandscapeTransmission.zip)",
    );
    expect(downloadAttachment).toHaveBeenCalledWith({
      attachmentId: "FLARGE",
      chatId: "C123",
      threadId: "1712790000.000050",
      messageId: "1712800000.000100",
      signal: expect.any(AbortSignal),
    });
  });

  test("does not infer the active route thread for channel-history attachment downloads", async () => {
    const registry = new ChannelRegistry();
    const downloadAttachment = mock(async () => ({
      id: "FHISTORY",
      name: "history.zip",
      kind: "file" as const,
      localPath: "/tmp/history.zip",
    }));
    const adapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "unused" }),
      sendDirectReply: async () => {},
      downloadAttachment,
    };
    registry.registerAdapter(adapter);
    setRouteInMemory("slack", {
      accountId: "account-1",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712800000.000100",
      agentId: "agent-1",
      conversationId: "conv-thread",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    await message_channel({
      action: "download-file",
      channel: "slack",
      chat_id: "C123",
      attachmentId: "FHISTORY",
      messageId: "1712700000.000010",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(downloadAttachment).toHaveBeenCalledWith({
      attachmentId: "FHISTORY",
      chatId: "C123",
      threadId: null,
      messageId: "1712700000.000010",
      signal: expect.any(AbortSignal),
    });
  });

  test("rejects Slack attachment downloads through proactive targets", async () => {
    const registry = new ChannelRegistry();
    const downloadAttachment = mock(async () => ({
      id: "FLARGE",
      kind: "file" as const,
      localPath: "/tmp/large.zip",
    }));
    const adapter = {
      id: "slack:account-1",
      channelId: "slack",
      accountId: "account-1",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "unused" }),
      sendDirectReply: async () => {},
      downloadAttachment,
    };
    registry.registerAdapter(adapter);

    const result = await message_channel({
      action: "download-file",
      channel: "slack",
      target: "#private-channel",
      attachmentId: "FLARGE",
      messageId: "1712800000.000100",
      parentScope: {
        agentId: "agent-1",
        conversationId: "conv-thread",
      },
    });

    expect(result).toBe(
      "Error: Slack download-file requires chat_id from a routed channel context; target is not supported.",
    );
    expect(downloadAttachment).not.toHaveBeenCalled();
  });

  test("supports proactive Slack sends to explicit cached targets without consulting routes", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "slack-msg-proactive-1",
    }));

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
    registry.getRouteForScope = mock(() => {
      throw new Error("explicit target path should not consult routes");
    });

    setRouteInMemory("slack", {
      accountId: "account-1",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "account-1",
      displayName: "DocsBot Slack",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      mode: "socket",
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
    });
    upsertChannelTarget("slack", {
      accountId: "account-1",
      targetId: "C999",
      targetType: "channel",
      chatId: "C999",
      label: "#eng",
      discoveredAt: "2026-04-11T00:00:00.000Z",
      lastSeenAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      target: "#eng",
      message: "hello proactive slack",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to slack");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "slack",
      accountId: "account-1",
      chatId: "C999",
      text: "hello proactive slack",
      replyToMessageId: undefined,
      threadId: null,
      parseMode: undefined,
      agentId: "agent-1",
      conversationId: "default",
    });
  });

  test("requires accountId when multiple proactive Slack accounts are eligible", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "slack-msg-proactive-2",
    }));

    const adapter1: ChannelAdapter = {
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
    const adapter2: ChannelAdapter = {
      id: "slack:account-2",
      channelId: "slack",
      accountId: "account-2",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter1);
    registry.registerAdapter(adapter2);

    setRouteInMemory("slack", {
      accountId: "account-1",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });
    setRouteInMemory("slack", {
      accountId: "account-2",
      chatId: "C124",
      chatType: "channel",
      threadId: "1712790000.000051",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "account-1",
      displayName: "DocsBot Slack",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      mode: "socket",
      botToken: "xoxb-test-token-1",
      appToken: "xapp-test-token-1",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
    });
    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "account-2",
      displayName: "SupportBot Slack",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      mode: "socket",
      botToken: "xoxb-test-token-2",
      appToken: "xapp-test-token-2",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      target: "#eng",
      message: "hello proactive slack",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe(
      "Error: Multiple proactive Slack accounts are available for this agent. Pass accountId.",
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("rejects proactive Slack sends for accounts outside the agent scope", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "slack-msg-proactive-3",
    }));

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
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "account-1",
      displayName: "DocsBot Slack",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      mode: "socket",
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
    });

    const result = await message_channel({
      action: "send",
      channel: "slack",
      target: "#eng",
      accountId: "other-account",
      message: "hello proactive slack",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe(
      'Error: Slack account "other-account" is not available for proactive sends in this agent scope.',
    );
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
