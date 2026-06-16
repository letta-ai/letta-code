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
import type { ChannelAdapter, TelegramChannelAccount } from "@/channels/types";
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

  function upsertTelegramTestAccount(
    overrides: Partial<TelegramChannelAccount> = {},
  ): void {
    upsertChannelAccount("telegram", {
      channel: "telegram",
      accountId: "account-1",
      displayName: "Telegram",
      enabled: true,
      token: "telegram-token",
      dmPolicy: "pairing",
      allowedUsers: [],
      binding: {
        agentId: null,
        conversationId: null,
      },
      groupMode: "open",
      transcribeVoice: false,
      richPrivateChatDefault: true,
      richDraftStreaming: false,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      ...overrides,
    });
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

  test("does not reuse route thread ids for Telegram private chats", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "telegram-msg-private",
    }));

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
    upsertTelegramTestAccount({ richPrivateChatDefault: false });

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      chatType: "direct",
      threadId: "42",
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
      message: "hello private chat",
      threadId: "",
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
      text: "hello private chat",
      replyToMessageId: undefined,
      threadId: null,
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: "HTML",
    });
  });

  test("routes Telegram send-rich as rich markdown with HTML fallback", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-rich-1" }));

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
    upsertTelegramTestAccount({ richPrivateChatDefault: false });

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const richMarkdown = "# Title\n\n- **item** & detail";
    const result = await message_channel({
      action: "send-rich",
      channel: "telegram",
      chat_id: "7952253975",
      message: richMarkdown,
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
      text: "# Title\n\n- <b>item</b> &amp; detail",
      replyToMessageId: "42",
      threadId: null,
      mediaPath: undefined,
      fileName: undefined,
      title: undefined,
      parseMode: "HTML",
      richMessage: { markdown: richMarkdown },
    });
  });

  test("defaults Telegram private chat sends to rich markdown", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-rich-2" }));

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
    upsertTelegramTestAccount({ richPrivateChatDefault: true });

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const markdown = "# Default rich\n\n- **private** chat";
    const result = await message_channel({
      action: "send",
      channel: "telegram",
      chat_id: "7952253975",
      message: markdown,
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "account-1",
        chatId: "7952253975",
        richMessage: { markdown },
      }),
    );
  });

  test("keeps Telegram private chat sends plain when account disables default rich messaging", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-plain-2" }));

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
    upsertTelegramTestAccount({ richPrivateChatDefault: false });

    setRouteInMemory("telegram", {
      accountId: "account-1",
      chatId: "7952253975",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const markdown = "# Plain private fallback\n\n- **private** chat";
    const result = await message_channel({
      action: "send",
      channel: "telegram",
      chat_id: "7952253975",
      message: markdown,
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        richMessage: expect.anything(),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        accountId: "account-1",
        chatId: "7952253975",
        text: "# Plain private fallback\n\n- <b>private</b> chat",
        parseMode: "HTML",
      }),
    );
  });

  test("keeps Telegram channel sends plain unless send-rich is explicit", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-plain-1" }));

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
      chatId: "-1003904563283",
      chatType: "channel",
      threadId: "42",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send",
      channel: "telegram",
      chat_id: "-1003904563283",
      message: "# Plain channel fallback",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({
        richMessage: expect.anything(),
      }),
    );
  });

  test("passes common Telegram rich Markdown constructs through unchanged", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "telegram-rich-fixture",
    }));

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
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const fixtures = [
      {
        name: "headings lists quotes and code",
        markdown:
          "# Heading\n\n- **bold item**\n- `inline code`\n\n> Rich block quote",
      },
      {
        name: "tables task lists and footnotes",
        markdown:
          "| Metric | Value |\n|:-------|------:|\n| Speed | **42** ms |\n\n- [ ] pending task\n- [x] complete task\n\nText with a footnote[^note].\n\n[^note]: Footnote content.",
      },
      {
        name: "dollar math",
        markdown:
          "Inline math: $E = mc^2$\n\nDisplay math:\n\n$$\n\\nabla_\\theta J(\\theta) = \\mathbb{E}_{\\tau \\sim \\pi_\\theta}[R(\\tau)]\n$$",
      },
      {
        name: "details with markdown content",
        markdown:
          "<details open><summary>Summary with **bold**</summary>\n\n## Nested heading\n\n- _Nested item_\n\n</details>",
      },
    ];

    for (const fixture of fixtures) {
      const result = await message_channel({
        action: "send-rich",
        channel: "telegram",
        chat_id: "7952253975",
        message: fixture.markdown,
        parentScope: {
          agentId: "agent-1",
          conversationId: "default",
        },
      });

      expect(result).toContain("Message sent to telegram");
    }

    expect(sendMessage).toHaveBeenCalledTimes(fixtures.length);
    fixtures.forEach((fixture, index) => {
      expect(sendMessage).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({
          channel: "telegram",
          accountId: "account-1",
          chatId: "7952253975",
          replyToMessageId: undefined,
          threadId: null,
          parseMode: "HTML",
          richMessage: { markdown: fixture.markdown },
        }),
      );
    });
  });

  test("does not treat Telegram direct message ids as forum thread ids", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-rich-2" }));

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
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const result = await message_channel({
      action: "send-rich",
      channel: "telegram",
      chat_id: "7952253975",
      message: "# Title",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
      channelTurnSources: [
        {
          channel: "telegram",
          accountId: "account-1",
          chatId: "7952253975",
          chatType: "direct",
          messageId: "14245",
          threadId: null,
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        chatId: "7952253975",
        threadId: null,
        richMessage: { markdown: "# Title" },
      }),
    );
  });

  test("rejects Telegram send-rich with local media uploads", async () => {
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({ messageId: "telegram-rich-1" }));

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
      action: "send-rich",
      channel: "telegram",
      chat_id: "7952253975",
      message: "# Title",
      media: "/tmp/screenshot.png",
      parentScope: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    expect(result).toContain("send-rich does not support local media uploads");
    expect(sendMessage).not.toHaveBeenCalled();
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
