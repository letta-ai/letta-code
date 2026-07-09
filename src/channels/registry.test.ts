import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  createPairingCode,
  getPendingPairings,
  isUserApproved,
} from "@/channels/pairing";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import {
  buildSlackConversationSummary,
  ChannelInitializationError,
  ChannelRegistry,
  completePairing,
  getChannelRegistry,
  initializeChannels,
} from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import type {
  ChannelAdapter,
  ChannelControlRequestEvent,
  InboundChannelMessage,
  SignalChannelAccount,
} from "@/channels/types";

beforeEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

afterEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

describe("ChannelRegistry", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test("pause() stops delivery but keeps singleton alive", () => {
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setReady();

    expect(registry.isReady()).toBe(true);
    expect(getChannelRegistry()).toBe(registry);

    registry.pause();
    expect(registry.isReady()).toBe(false);
    // Singleton survives pause (unlike stopAll)
    expect(getChannelRegistry()).toBe(registry);

    // Re-register and setReady (simulates WS reconnect)
    registry.setMessageHandler(() => {});
    registry.setReady();
    expect(registry.isReady()).toBe(true);
  });

  test("stopAll() destroys the singleton", async () => {
    const registry = new ChannelRegistry();
    expect(getChannelRegistry()).toBe(registry);

    await registry.stopAll();
    expect(getChannelRegistry()).toBeNull();
  });

  test("route-derived recovery sources do not invent an originating message", () => {
    const registry = new ChannelRegistry();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });

    expect(registry.resolveTurnSourcesForScope("agent-1", "conv-1")).toEqual([
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    ]);
  });

  test("initializeChannels throws when requested channel startup fails", async () => {
    __testOverrideLoadChannelAccounts(() => []);
    const logs: string[] = [];

    await expect(
      initializeChannels(["telegram"], {
        failOnStartupError: true,
        logger: (message) => logs.push(message),
      }),
    ).rejects.toBeInstanceOf(ChannelInitializationError);

    expect(logs).toContain("[Channels] requested: telegram");
    expect(logs.some((line) => line.includes("root:"))).toBe(true);
    expect(logs.some((line) => line.includes("accounts=0"))).toBe(true);
  });

  test("startChannelAccount rejects Signal accounts sharing one daemon", async () => {
    const now = "2026-06-17T00:00:00.000Z";
    const makeSignalAccount = (
      accountId: string,
      account: string,
    ): SignalChannelAccount => ({
      channel: "signal",
      accountId,
      displayName: accountId,
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: now,
      updatedAt: now,
      baseUrl: "http://127.0.0.1:8080/",
      account,
      agentId: null,
      selfChatMode: false,
      groupMode: "disabled",
      allowedGroups: [],
      mentionPatterns: [],
      recipientAliases: {},
      downloadMedia: true,
    });
    __testOverrideLoadChannelAccounts(() => [
      makeSignalAccount("one", "+15555550100"),
      makeSignalAccount("two", "+15555550101"),
    ]);
    const registry = new ChannelRegistry();

    await expect(registry.startChannelAccount("signal", "one")).rejects.toThrow(
      /share base_url/,
    );
  });

  test("initializeChannels does not start accounts outside the restore scope", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-cloud-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-cloud",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    const logs: string[] = [];

    await expect(
      initializeChannels(["slack"], {
        restoreAgentScope: "local",
        logger: (message) => logs.push(message),
      }),
    ).resolves.toBeInstanceOf(ChannelRegistry);

    expect(logs).toContain(
      '[Channels] Channel "slack" has no enabled accounts in local restore scope.',
    );
  });

  test("/help gets a direct channel reply instead of being delivered to the agent", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "acct-telegram",
        enabled: true,
        token: "test-token",
        dmPolicy: "open",
        allowedUsers: [],
        binding: { agentId: null, conversationId: null },
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: " /HELP ",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
    });
    expect(replies[0]?.text).toContain("Telegram is connected to Letta Code");
  });

  test("Slack threaded DM slash command replies stay in the DM thread", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
      threadId?: string | null;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
          threadId: options?.threadId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "D123",
      senderId: "U123",
      senderName: "Charles",
      text: "/help",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: "D123",
      replyToMessageId: "1712800000.000200",
      threadId: "1712790000.000050",
    });
    expect(replies[0]?.text).toContain("Slack is connected to Letta Code");
  });

  test("unsupported slash commands get direct channel guidance instead of agent delivery", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "/compact now",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
    });
    expect(replies[0]?.text).toContain(
      "Telegram received /compact now, but that slash command is not supported in channels yet.",
    );
  });

  test("/status replies with route status instead of being delivered to the agent", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "acct-telegram",
        enabled: true,
        token: "test-token",
        dmPolicy: "open",
        allowedUsers: [],
        binding: { agentId: null, conversationId: null },
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-status",
      conversationId: "conv-status",
      enabled: true,
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "/status",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
    });
    expect(replies[0]?.text).toContain("Telegram status");
    expect(replies[0]?.text).toContain(
      "Route: Connected to a Letta agent conversation.",
    );
    expect(replies[0]?.text).toContain("Agent: agent-status.");
    expect(replies[0]?.text).toContain("Conversation: conv-status.");
  });

  test("/pause and /resume update the current route without agent delivery", async () => {
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    });

    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "/pause",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies.at(-1)).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
    });
    expect(replies.at(-1)?.text).toContain("paused agent routing");
    expect(getRoute("telegram", "123", "acct-telegram")).toBeNull();

    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "/resume",
      timestamp: Date.now(),
      messageId: "78",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies.at(-1)).toMatchObject({
      chatId: "123",
      replyToMessageId: "78",
    });
    expect(replies.at(-1)?.text).toContain("resumed agent routing");
    expect(getRoute("telegram", "123", "acct-telegram")?.conversationId).toBe(
      "conv-1",
    );
  });

  test("/cancel invokes the channel cancel handler for the routed chat", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const cancellations: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setCancelHandler(async (params) => {
      cancellations.push(params);
      return true;
    });
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/cancel",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
    });

    expect(delivered).toHaveLength(0);
    expect(cancellations).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Slack cancelled the in-progress agent turn for this chat.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("/cancel reports when the routed chat has no active turn", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setCancelHandler(async () => false);
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      text: "/cancel",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(replies[0]?.text).toBe(
      "Telegram received /cancel, but there is no in-progress agent turn to cancel for this chat.",
    );
  });

  test("/cancel can target the sole Slack thread route when native commands omit thread metadata", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const cancellations: unknown[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setCancelHandler(async (params) => {
      cancellations.push(params);
      return true;
    });
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/cancel",
      timestamp: Date.now(),
      messageId: "trigger-1",
      threadId: null,
      chatType: "channel",
    });

    expect(cancellations).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies[0]?.text).toBe(
      "Slack cancelled the in-progress agent turn for this chat.",
    );
  });

  test("/chat replies with the web chat link for the routed conversation", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      text: "/chat",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies[0]?.text).toContain(
      "https://app.letta.com/chat/agent-1?conversation=conv-1",
    );
    expect(replies[0]?.text).toContain("Conversation: conv-1.");
  });

  test("/model invokes the channel model handler for the routed conversation", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const modelCalls: unknown[] = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setModelHandler(async (params) => {
      modelCalls.push(params);
      return {
        handled: true,
        text: params.modelIdentifier
          ? `Switched to ${params.modelIdentifier}`
          : "Model selector text",
      };
    });
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/model",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
    });
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/model openai/gpt-5",
      timestamp: Date.now(),
      messageId: "1712800000.000201",
      threadId: "1712790000.000050",
      chatType: "channel",
    });

    expect(delivered).toHaveLength(0);
    expect(modelCalls).toEqual([
      {
        channelId: "slack",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        modelIdentifier: undefined,
      },
      {
        channelId: "slack",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        modelIdentifier: "openai/gpt-5",
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Model selector text",
        replyToMessageId: "1712800000.000200",
      },
      {
        chatId: "C123",
        text: "Switched to openai/gpt-5",
        replyToMessageId: "1712800000.000201",
      },
    ]);
  });

  test("/model reports no route without invoking the model handler", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const modelCalls: unknown[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setModelHandler(async (params) => {
      modelCalls.push(params);
      return { handled: true, text: "unused" };
    });
    registry.setReady();
    registry.registerAdapter({
      id: "telegram:acct-telegram",
      channelId: "telegram",
      accountId: "acct-telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      text: "/model sonnet",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(modelCalls).toHaveLength(0);
    expect(replies[0]?.text).toContain(
      "Telegram could not find an existing route for this chat.",
    );
  });

  test("/reflection invokes the channel reflection handler for the routed conversation", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const reflections: unknown[] = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReflectionHandler(async (params) => {
      reflections.push(params);
      return { handled: true, text: "Started a reflection pass." };
    });
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/reflection",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
    });

    expect(delivered).toHaveLength(0);
    expect(reflections).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies[0]?.text).toBe("Started a reflection pass.");
  });

  test("Slack root channel routes do not catch unmentioned thread input", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const reflections: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReflectionHandler(async (params) => {
      reflections.push(params);
      return { handled: true, text: "Started a reflection pass." };
    });
    registry.setReady();
    registry.registerAdapter({
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      onMessage: undefined,
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "ok i think i did it",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    });
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text: "/reflection",
      timestamp: Date.now(),
      messageId: "1712800000.000201",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    });

    expect(delivered).toHaveLength(0);
    expect(reflections).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});

describe("buildSlackConversationSummary", () => {
  test("labels direct messages with the sender name", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "D123",
        chatType: "direct",
        senderId: "U123",
        senderName: "Charles",
        text: "hey there",
      }),
    ).toBe("[Slack] DM with Charles");
  });

  test("labels threaded direct messages with a clipped text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "D123",
        chatType: "direct",
        threadId: "1712790000.000050",
        senderId: "U123",
        senderName: "Charles",
        text: "  following up in the DM thread about the deploy preview  ",
      }),
    ).toBe(
      "[Slack] DM thread with Charles: following up in the DM thread about the deploy preview",
    );
  });

  test("labels channel threads with a clipped text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "  what messages do you see in this thread right now?  ",
      }),
    ).toBe(
      "[Slack] Thread: what messages do you see in this thread right now?",
    );
  });

  test("includes the channel label when available", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatLabel: "#random",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "Need help with the deploy preview environment after lunch",
      }),
    ).toBe(
      "[Slack] Thread in #random: Need help with the deploy preview environment after lunch",
    );
  });

  test("falls back when a thread has no text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "   ",
      }),
    ).toBe("[Slack] Thread C123");
  });
});

describe("completePairing", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
  });

  test("successful pairing creates route", () => {
    new ChannelRegistry();

    const code = createPairingCode("telegram", "user-1", "chat-1", "john");
    const result = completePairing("telegram", code, "agent-a", "conv-1");

    expect(result.success).toBe(true);
    expect(result.chatId).toBe("chat-1");

    const route = getRoute("telegram", "chat-1");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
    expect(route?.conversationId).toBe("conv-1");
  });

  test("invalid code returns error", () => {
    new ChannelRegistry();

    const result = completePairing("telegram", "BADCODE", "agent-a", "conv-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid or expired");
  });

  test("rolls back both in-memory route and pairing when disk write fails", () => {
    new ChannelRegistry();

    const code = createPairingCode("telegram", "user-1", "chat-99", "john");

    // Make saveRoutes throw to simulate disk write failure.
    // addRoute() calls routesByKey.set() (succeeds) then saveRoutes() (throws).
    // The completePairing catch path must:
    //   1. Remove the in-memory route via removeRouteInMemory (no disk write)
    //   2. Restore the pending pairing code via rollbackPairingApproval
    __testOverrideSaveRoutes(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = completePairing("telegram", code, "agent-a", "conv-1");

    // Should report failure with rollback
    expect(result.success).toBe(false);
    expect(result.error).toContain("rolled back");
    expect(result.error).toContain("EACCES");

    // In-memory route must NOT exist
    expect(getRoute("telegram", "chat-99")).toBeNull();

    // Pairing must be rolled back: user not approved, pending code restored
    expect(isUserApproved("telegram", "user-1")).toBe(false);
    expect(getPendingPairings("telegram")).toHaveLength(1);
    expect(getPendingPairings("telegram")[0]?.code).toBe(code);
  });

  test("restores pre-existing route when rebind fails", () => {
    new ChannelRegistry();

    // Set up an existing route for chat-50
    addRoute("telegram", {
      chatId: "chat-50",
      agentId: "agent-old",
      conversationId: "conv-old",
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
    });

    // Verify it exists
    const before = getRoute("telegram", "chat-50");
    expect(before).not.toBeNull();
    expect(before?.agentId).toBe("agent-old");

    // Create a pairing for the same chat
    const code = createPairingCode("telegram", "user-2", "chat-50", "jane");

    // Make saveRoutes throw on the rebind attempt
    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    const result = completePairing("telegram", code, "agent-new", "conv-new");
    expect(result.success).toBe(false);

    // The OLD route must still be in memory (restored from snapshot)
    const after = getRoute("telegram", "chat-50");
    expect(after).not.toBeNull();
    expect(after?.agentId).toBe("agent-old");
    expect(after?.conversationId).toBe("conv-old");
  });
});

describe("pending channel control requests", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
  });

  function createAdapter(
    replies: Array<{ chatId: string; text: string; replyToMessageId?: string }>,
  ): ChannelAdapter {
    return {
      id: "slack:acct-slack",
      channelId: "slack",
      accountId: "acct-slack",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
      handleControlRequestEvent: async () => {},
      onMessage: undefined,
    };
  }

  function createInboundMessage(
    text: string,
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      text,
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      ...overrides,
    };
  }

  test("accepted Slack route dispatches immediate queued lifecycle before delivery", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const order: string[] = [];
    const adapter = createAdapter([]);
    adapter.handleTurnLifecycleEvent = async (event) => {
      order.push("lifecycle");
      lifecycleEvents.push(event);
    };
    adapter.prepareInboundMessage = async (message) => {
      order.push("prepare");
      return message;
    };
    registry.registerAdapter(adapter);
    registry.setMessageHandler((delivery) => {
      order.push("deliver");
      delivered.push(delivery);
    });
    registry.setReady();
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await adapter.onMessage?.(createInboundMessage("hello"));

    expect(lifecycleEvents).toEqual([
      {
        type: "queued",
        source: expect.objectContaining({
          channel: "slack",
          accountId: "acct-slack",
          chatId: "C123",
          threadId: "1712790000.000050",
          agentId: "agent-1",
          conversationId: "conv-1",
        }),
      },
    ]);
    expect(delivered).toHaveLength(1);
    expect(order).toEqual(["lifecycle", "prepare", "deliver"]);
  });

  test("unrouted Slack thread replies do not dispatch assistant status", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-06-17T00:00:00.000Z",
        updatedAt: "2026-06-17T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    const lifecycleEvents: unknown[] = [];
    const adapter = createAdapter([]);
    adapter.handleTurnLifecycleEvent = async (event) => {
      lifecycleEvents.push(event);
    };
    registry.registerAdapter(adapter);
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage("unrelated thread", {
        messageId: "1712800000.999999",
        threadId: "1712790000.999999",
      }),
    );

    expect(lifecycleEvents).toEqual([]);
    expect(delivered).toEqual([]);
  });

  function createPendingControlRequestEvent(
    overrides: Partial<ChannelControlRequestEvent> = {},
  ): ChannelControlRequestEvent {
    return {
      requestId: "req-ask-1",
      kind: "ask_user_question",
      source: {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which approach should we use?",
            header: "Approach",
            options: [
              {
                label: "Fast path",
                description: "Ship the smallest safe patch",
              },
              {
                label: "Deep refactor",
                description: "Restructure the code more thoroughly",
              },
            ],
            multiSelect: false,
          },
        ],
      },
      ...overrides,
    };
  }

  test("channel replies resolve pending AskUserQuestion prompts instead of normal ingress", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });

    const approvalResponses: Array<{
      runtime: { agent_id?: string | null; conversation_id?: string | null };
      response: unknown;
    }> = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("2"));

    expect(deliveries).toHaveLength(0);
    expect(replies).toHaveLength(0);
    expect(approvalResponses).toHaveLength(1);
    expect(approvalResponses[0]).toEqual({
      runtime: {
        agent_id: "agent-1",
        conversation_id: "conv-1",
      },
      response: {
        request_id: "req-ask-1",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  {
                    label: "Fast path",
                    description: "Ship the smallest safe patch",
                  },
                  {
                    label: "Deep refactor",
                    description: "Restructure the code more thoroughly",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
            },
          },
        },
      },
    });
  });

  test("native approval controls resolve the exact request and enforce the initiating sender", async () => {
    const registry = new ChannelRegistry();
    const adapter = createAdapter([]);
    registry.registerAdapter(adapter);
    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const baseEvent = createPendingControlRequestEvent();
    await registry.registerPendingControlRequest({
      ...baseEvent,
      kind: "generic_tool_approval",
      source: { ...baseEvent.source, senderId: "U123" },
      toolName: "Bash",
      input: { command: "bun test" },
    });

    const baseInput = {
      requestId: baseEvent.requestId,
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      threadId: "1712790000.000050",
      response: {
        request_id: baseEvent.requestId,
        decision: { behavior: "allow" as const },
      },
    };
    expect(
      await adapter.onControlResponse?.({
        ...baseInput,
        senderId: "U999",
      }),
    ).toBe("forbidden");
    expect(approvalResponses).toHaveLength(0);
    expect(registry.hasPendingControlRequest(baseEvent.requestId)).toBe(true);

    expect(
      await adapter.onControlResponse?.({
        ...baseInput,
        senderId: "U123",
      }),
    ).toBe("handled");
    expect(approvalResponses).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        response: baseInput.response,
      },
    ]);
    expect(registry.hasPendingControlRequest(baseEvent.requestId)).toBe(false);
  });

  test("Slack thread text stays queued steering input while a native approval is pending", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "open",
        allowedUsers: [],
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
    ]);
    const registry = new ChannelRegistry();
    const adapter = createAdapter([]);
    registry.registerAdapter(adapter);
    const deliveries: unknown[] = [];
    const approvalResponses: unknown[] = [];
    registry.setMessageHandler((delivery) => deliveries.push(delivery));
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    registry.setReady();
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
    });
    const event = createPendingControlRequestEvent();
    await registry.registerPendingControlRequest({
      ...event,
      kind: "generic_tool_approval",
      toolName: "Bash",
      input: { command: "bun test" },
    });

    await adapter.onMessage?.(
      createInboundMessage("wait, do not run that yet"),
    );

    expect(approvalResponses).toHaveLength(0);
    expect(deliveries).toHaveLength(1);
    expect(registry.hasPendingControlRequest(event.requestId)).toBe(true);
  });

  test("/cancel bypasses pending channel control prompts", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);
    registry.setMessageHandler(() => {});

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const cancellations: unknown[] = [];
    registry.setCancelHandler(async (params) => {
      cancellations.push(params);
      return true;
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("/cancel"));

    expect(approvalResponses).toHaveLength(0);
    expect(cancellations).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Slack cancelled the in-progress agent turn for this chat.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("/reflection bypasses pending channel control prompts", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);
    registry.setMessageHandler(() => {});

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async (params) => {
      approvalResponses.push(params);
      return true;
    });
    const reflections: unknown[] = [];
    registry.setReflectionHandler(async (params) => {
      reflections.push(params);
      return { handled: true, text: "Started a reflection pass." };
    });
    addRoute("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    await registry.registerPendingControlRequest(
      createPendingControlRequestEvent(),
    );

    await adapter.onMessage?.(createInboundMessage("/reflection"));

    expect(approvalResponses).toHaveLength(0);
    expect(reflections).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Started a reflection pass.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("freeform multi-question channel replies approve instead of reprompting", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const approvalResponses: unknown[] = [];
    registry.setApprovalResponseHandler(async ({ response }) => {
      approvalResponses.push(response);
      return true;
    });

    await registry.registerPendingControlRequest({
      requestId: "req-ask-2",
      kind: "ask_user_question",
      source: {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        messageId: "1712800000.000100",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
      toolName: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Which approach should we use?",
            header: "Approach",
            options: [
              { label: "Fast path", description: "Ship quickly" },
              { label: "Deep refactor", description: "Refactor more" },
            ],
            multiSelect: false,
          },
          {
            question: "Which environment should we test in?",
            header: "Env",
            options: [
              { label: "Staging", description: "Safer rollout path" },
              { label: "Production", description: "Use the live environment" },
            ],
            multiSelect: false,
          },
        ],
      },
    });

    await adapter.onMessage?.(createInboundMessage("deep refactor please"));

    expect(replies).toHaveLength(0);
    expect(approvalResponses).toEqual([
      {
        request_id: "req-ask-2",
        decision: {
          behavior: "allow",
          updated_input: {
            questions: [
              {
                question: "Which approach should we use?",
                header: "Approach",
                options: [
                  { label: "Fast path", description: "Ship quickly" },
                  { label: "Deep refactor", description: "Refactor more" },
                ],
                multiSelect: false,
              },
              {
                question: "Which environment should we test in?",
                header: "Env",
                options: [
                  { label: "Staging", description: "Safer rollout path" },
                  {
                    label: "Production",
                    description: "Use the live environment",
                  },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              "Which approach should we use?": "Deep refactor",
              "Which environment should we test in?":
                "Not specified. Full user reply: deep refactor please",
            },
          },
        },
      },
    ]);
  });

  test("bootstrapped persisted control requests intercept replies before the listener finishes reconnecting", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [createPendingControlRequestEvent()],
    }));

    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    await adapter.onMessage?.(createInboundMessage("approve"));

    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "I’m reconnecting to Letta Code right now, so I couldn’t use that reply yet. Please send it again in a moment.",
        replyToMessageId: "1712790000.000050",
      },
    ]);
  });

  test("clearing a bootstrapped control request also removes it from the persisted store", () => {
    const saveSnapshots: Array<{ requests: ChannelControlRequestEvent[] }> = [];
    __testOverrideLoadPendingControlRequestStore(() => ({
      requests: [createPendingControlRequestEvent()],
    }));
    __testOverrideSavePendingControlRequestStore((store) => {
      saveSnapshots.push({
        requests: store.requests,
      });
    });

    const registry = new ChannelRegistry();
    registry.clearPendingControlRequest("req-ask-1");

    expect(saveSnapshots.at(-1)).toEqual({ requests: [] });
  });
});
