import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { __testClearUserChannelPluginCache } from "@/channels/plugin-registry";
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

describe("MessageChannel", () => {
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
    });
  });

  test("formats and sends Telegram messages through the routed account adapter", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-msg-1" }));

    const adapter: ChannelAdapter = {
      id: "telegram:account-1",
      channelId: "telegram",
      accountId: "account-1",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "telegram",
      chat_id: "7952253975",
      message: "hello **world** & team",
      replyTo: "42",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "account-1",
      chatId: "7952253975",
      text: "hello <b>world</b> &amp; team",
      replyToMessageId: "42",
      threadId: null,
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: "HTML",
    });
  });

  test("infers accountId from channel turn source for duplicate Telegram chat routes", async () => {
    const registry = new ChannelRegistry();

    const oldSendMessage = mock(async () => ({ messageId: "old-msg" }));
    const newSendMessage = mock(async () => ({ messageId: "new-msg" }));

    const oldAdapter: ChannelAdapter = {
      id: "telegram:old-account",
      channelId: "telegram",
      accountId: "old-account",
      name: "Telegram Old",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: oldSendMessage,
      sendDirectReply: async () => {},
    };
    const newAdapter: ChannelAdapter = {
      id: "telegram:new-account",
      channelId: "telegram",
      accountId: "new-account",
      name: "Telegram New",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: newSendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(oldAdapter);
    registry.registerAdapter(newAdapter);

    for (const accountId of ["old-account", "new-account"]) {
      setRouteInMemory("telegram", {
        accountId,
        chatId: "7952253975",
        agentId: "agent-1",
        conversationId: "default",
        enabled: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      });
    }

    const result = await message_channel({
      action: "send",
      channel: "telegram",
      chat_id: "7952253975",
      message: "hello new bot",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
      channelTurnSources: [
        {
          channel: "telegram",
          accountId: "new-account",
          chatId: "7952253975",
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    expect(result).toContain("Message sent to telegram");
    expect(oldSendMessage).not.toHaveBeenCalled();
    expect(newSendMessage).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "new-account",
      chatId: "7952253975",
      text: "hello new bot",
      replyToMessageId: undefined,
      threadId: null,
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: "HTML",
    });
  });

  test("uploads Telegram media through the routed account adapter", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-media-1" }));

    const adapter: ChannelAdapter = {
      id: "telegram:account-1",
      channelId: "telegram",
      accountId: "account-1",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "upload-file",
      channel: "telegram",
      chat_id: "7952253975",
      message: "see attached",
      media: "/tmp/screenshot.png",
      filename: "screenshot.png",
      title: "Screenshot",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Attachment sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "account-1",
      chatId: "7952253975",
      text: "see attached",
      replyToMessageId: undefined,
      threadId: null,
      mediaPath: "/tmp/screenshot.png",
      fileName: "screenshot.png",
      title: "Screenshot",
      parseMode: "HTML",
    });
  });

  test("passes Telegram reactions through MessageChannel with the routed account", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-msg-2" }));

    const adapter: ChannelAdapter = {
      id: "telegram:account-1",
      channelId: "telegram",
      accountId: "account-1",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "react",
      channel: "telegram",
      chat_id: "7952253975",
      emoji: "👍",
      messageId: "99",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Reaction added on telegram");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "account-1",
      chatId: "7952253975",
      text: "",
      targetMessageId: "99",
      reaction: "👍",
      removeReaction: undefined,
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
      // `text` is a legacy alias not in the core schema; it passes through as
      // a plugin-owned field at the type level (index signature) but is
      // rejected at runtime by the Slack plugin's handleAction.
      text: "hello from legacy args",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe("Error: Slack send requires message or media.");
    expect(sendMessage).not.toHaveBeenCalled();
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
});

describe("MessageChannel plugin field passthrough", () => {
  let channelsRoot: string;

  beforeEach(() => {
    channelsRoot = mkdtempSync(join(tmpdir(), "letta-plugin-fields-"));
    __testOverrideChannelsRoot(channelsRoot);
    __testClearUserChannelPluginCache();
  });

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
    __testOverrideChannelsRoot(null);
    __testClearUserChannelPluginCache();
    rmSync(channelsRoot, { recursive: true, force: true });
  });

  /**
   * Create a user channel plugin ("testchan") that:
   *  - declares a custom action "wave" and a schema contribution for
   *    `reply_to_uri` and `control_command` (simulating a Bluesky-like plugin)
   *  - reads `request.pluginFields` in handleAction and returns them so the
   *    test can verify passthrough
   */
  function writeTestChannelPlugin(): void {
    const channelDir = join(channelsRoot, "testchan");
    mkdirSync(channelDir, { recursive: true });
    writeFileSync(
      join(channelDir, "channel.json"),
      `${JSON.stringify(
        {
          id: "testchan",
          displayName: "Test Channel",
          entry: "./plugin.mjs",
          runtimePackages: [],
          runtimeModules: [],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(channelDir, "plugin.mjs"),
      `export const channelPlugin = {
        metadata: {
          id: "testchan",
          displayName: "Test Channel",
          runtimePackages: [],
          runtimeModules: []
        },
        createAdapter(account) {
          return {
            id: "testchan:" + account.accountId,
            channelId: "testchan",
            accountId: account.accountId,
            name: "Test Channel",
            start: async () => {},
            stop: async () => {},
            isRunning: () => true,
            sendMessage: async () => ({ messageId: "tc-1" }),
            sendDirectReply: async () => {}
          };
        },
        messageActions: {
          describeMessageTool() {
            return {
              actions: ["wave"],
              schema: {
                properties: {
                  reply_to_uri: { type: "string", description: "URI of the post to reply to" },
                  control_command: { type: "string", description: "Bluesky-specific control command" }
                }
              }
            };
          },
          handleAction(ctx) {
            const pf = ctx.request.pluginFields ?? {};
            const keys = Object.keys(pf).sort();
            if (keys.length === 0) {
              return "no plugin fields received";
            }
            return "plugin fields: " + keys.map(k => k + "=" + String(pf[k])).join(", ");
          }
        }
      };\n`,
    );
  }

  test("plugin-owned top-level fields are forwarded to handleAction via pluginFields", async () => {
    writeTestChannelPlugin();

    const registry = new ChannelRegistry();
    const sendMessage = mock(async () => ({ messageId: "tc-msg-1" }));
    const adapter: ChannelAdapter = {
      id: "testchan:account-1",
      channelId: "testchan",
      accountId: "account-1",
      name: "Test Channel",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("testchan", {
      accountId: "account-1",
      chatId: "D-test",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "wave",
      channel: "testchan",
      chat_id: "D-test",
      // Plugin-owned fields that should be forwarded via pluginFields:
      reply_to_uri: "at://did:plc:xyz/app.bsky.feed.post/123",
      control_command: "delete",
      // Core fields that should NOT appear in pluginFields:
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("plugin fields:");
    expect(result).toContain("control_command=delete");
    expect(result).toContain(
      "reply_to_uri=at://did:plc:xyz/app.bsky.feed.post/123",
    );
    // Core fields should NOT leak into pluginFields:
    expect(result).not.toContain("message=");
    expect(result).not.toContain("chat_id=");
    expect(result).not.toContain("channel=");
  });

  test("pluginFields is absent when no plugin-owned fields are provided", async () => {
    writeTestChannelPlugin();

    const registry = new ChannelRegistry();
    const sendMessage = mock(async () => ({ messageId: "tc-msg-2" }));
    const adapter: ChannelAdapter = {
      id: "testchan:account-1",
      channelId: "testchan",
      accountId: "account-1",
      name: "Test Channel",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    };

    registry.registerAdapter(adapter);

    setRouteInMemory("testchan", {
      accountId: "account-1",
      chatId: "D-test",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "wave",
      channel: "testchan",
      chat_id: "D-test",
      message: "hello",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toBe("no plugin fields received");
  });
});
