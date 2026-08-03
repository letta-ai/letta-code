import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";

beforeEach(() => {
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
});

afterEach(async () => {
  const registry = getChannelRegistry();
  if (registry) {
    await registry.stopAll();
  }
  clearAllRoutes();
  clearChannelAccountStores();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

describe("ChannelRegistry compact command routing", () => {
  test("/compact invokes the handler for the exact routed conversation", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const compactions: unknown[] = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];

    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setCompactHandler(async (params) => {
      compactions.push(params);
      return {
        handled: true,
        text: "Compaction completed. Message buffer length reduced from 72 to 2.",
      };
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
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-08-03T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      senderName: "Alice",
      text: "/compact all",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(compactions).toEqual([
      {
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        args: "all",
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "123",
        text: "Compaction completed. Message buffer length reduced from 72 to 2.",
        replyToMessageId: "77",
      },
    ]);
  });
});
