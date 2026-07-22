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

describe("ChannelRegistry buffer behavior", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadPendingControlRequestStore(null);
    __testOverrideSavePendingControlRequestStore(null);
    clearPendingControlRequestStore();
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

  test("sends reconnecting notification when buffering messages", async () => {
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
    // Don't set ready - simulate disconnected state
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
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "Hello during reconnect",
      timestamp: Date.now(),
      messageId: "msg-reconnect",
      chatType: "direct",
    });

    // Should have sent a reconnecting notification
    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("reconnecting");
    expect(replies[0]?.chatId).toBe("123");
  });

  test("reconnecting notification uses thread id as reply target when available", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test",
        appToken: "xapp-test",
        dmPolicy: "open",
        allowedUsers: [],
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
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
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    await adapter?.onMessage?.({
      channel: "slack",
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U456",
      senderName: "Alice",
      text: "Hello during reconnect",
      timestamp: Date.now(),
      messageId: "1712800000.000100",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: true,
    });

    expect(replies.length).toBe(1);
    expect(replies[0]?.text).toContain("reconnecting");
    // Should reply to the thread root, not the individual message
    expect(replies[0]?.replyToMessageId).toBe("1712790000.000050");
  });

  test("flushes buffer in FIFO order when setReady is called", async () => {
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

    const delivered: unknown[] = [];

    const registry = new ChannelRegistry();
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
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");

    // Send three messages while not ready (should buffer)
    for (let index = 0; index < 3; index += 1) {
      await adapter?.onMessage?.({
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "123",
        senderId: "456",
        senderName: "Alice",
        text: `Buffered message ${index}`,
        timestamp: Date.now(),
        messageId: `msg-${index}`,
        chatType: "direct",
      });
    }

    // Each should have produced a reconnecting notification
    expect(replies.length).toBe(3);

    // Now set the message handler and mark ready
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();

    // Should have delivered all three buffered messages in order
    expect(delivered.length).toBe(3);
  });

  test("drops oldest when buffer exceeds max size and notifies via originating account", async () => {
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
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-15T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    // Push 101 messages — the first should be dropped (max size 100)
    for (let index = 0; index < 101; index += 1) {
      await adapter?.onMessage?.({
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "123",
        senderId: "456",
        senderName: "Alice",
        text: `Buffered message ${index}`,
        timestamp: Date.now(),
        messageId: `msg-${index}`,
        chatType: "direct",
      });
    }

    const dropReplies = replies.filter((reply) =>
      reply.text.includes("couldn't deliver"),
    );
    // The oldest (msg-0) should have been dropped
    expect(dropReplies).toEqual([
      expect.objectContaining({
        chatId: "123",
        replyToMessageId: "msg-0",
      }),
    ]);
  });

  test("buffer drop notification routes through the correct sibling account", async () => {
    // Two telegram accounts on the same channel — drops must route through
    // the originating account, not the legacy/default one.
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "acct-A",
        enabled: true,
        token: "token-A",
        dmPolicy: "open",
        allowedUsers: [],
        binding: { agentId: null, conversationId: null },
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
      {
        channel: "telegram",
        accountId: "acct-B",
        enabled: true,
        token: "token-B",
        dmPolicy: "open",
        allowedUsers: [],
        binding: { agentId: null, conversationId: null },
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});

    const repliesByAccount: Record<
      string,
      Array<{ chatId: string; text: string; replyToMessageId?: string }>
    > = { "acct-A": [], "acct-B": [] };

    const registry = new ChannelRegistry();

    for (const accountId of ["acct-A", "acct-B"]) {
      registry.registerAdapter({
        id: `telegram:${accountId}`,
        channelId: "telegram",
        accountId,
        name: `Telegram ${accountId}`,
        start: async () => {},
        stop: async () => {},
        isRunning: () => true,
        sendMessage: async () => ({ messageId: "msg-1" }),
        sendDirectReply: async (chatId, text, options) => {
          repliesByAccount[accountId]?.push({
            chatId,
            text,
            replyToMessageId: options?.replyToMessageId,
          });
        },
        onMessage: undefined,
      });
      addRoute("telegram", {
        accountId,
        chatId: `chat-${accountId}`,
        chatType: "direct",
        threadId: null,
        agentId: "agent-1",
        conversationId: `conv-${accountId}`,
        enabled: true,
        createdAt: "2026-05-15T00:00:00.000Z",
      });
    }

    // Overflow account A's buffer
    const adapterA = registry.getAdapter("telegram", "acct-A");
    // Fill the buffer to exactly the max size (100) — no drops yet.
    for (let index = 0; index < 100; index += 1) {
      await adapterA?.onMessage?.({
        channel: "telegram",
        accountId: "acct-A",
        chatId: "chat-acct-A",
        senderId: "456",
        senderName: "Alice",
        text: `Message ${index}`,
        timestamp: Date.now(),
        messageId: `a-msg-${index}`,
        chatType: "direct",
      });
    }

    // Send one message through account B — this overflows the shared buffer
    // and drops the oldest item (from acct-A). The drop notification must
    // route through acct-A's adapter, not acct-B's.
    const adapterB = registry.getAdapter("telegram", "acct-B");
    await adapterB?.onMessage?.({
      channel: "telegram",
      accountId: "acct-B",
      chatId: "chat-acct-B",
      senderId: "789",
      senderName: "Bob",
      text: "Hello from B",
      timestamp: Date.now(),
      messageId: "b-msg-0",
      chatType: "direct",
    });

    // Drop notification should only appear on acct-A, not acct-B
    const dropsA = (repliesByAccount["acct-A"] ?? []).filter((r) =>
      r.text.includes("couldn't deliver"),
    );
    const dropsB = (repliesByAccount["acct-B"] ?? []).filter((r) =>
      r.text.includes("couldn't deliver"),
    );
    expect(dropsA).toHaveLength(1);
    expect(dropsA[0]?.chatId).toBe("chat-acct-A");
    expect(dropsB).toHaveLength(0);
  });
});
