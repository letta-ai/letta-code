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
} from "@/channels/pairing";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";

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

describe("ChannelRegistry command routing", () => {
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
