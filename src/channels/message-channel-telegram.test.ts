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
} from "@/channels/targets";
import type { ChannelAdapter, TelegramChannelAccount } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";

describe("MessageChannel Telegram", () => {
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

  test("uses channel turn source thread ids for Telegram private topics", async () => {
    installChannelStateTestOverrides();
    const registry = new ChannelRegistry();

    const sendMessage = mock(async () => ({
      messageId: "telegram-msg-private-topic",
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
      threadId: null,
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
      message: "hello private topic",
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
          messageId: "77",
          threadId: "175380",
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    expect(result).toContain("Message sent to telegram");
    expect(sendMessage).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "account-1",
      chatId: "7952253975",
      text: "hello private topic",
      replyToMessageId: undefined,
      threadId: "175380",
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
});
