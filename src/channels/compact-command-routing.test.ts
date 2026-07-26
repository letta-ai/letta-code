import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  clearPendingControlRequestStore();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __testOverrideLoadPairingStore(null);
  __testOverrideSavePairingStore(null);
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
});

describe("ChannelRegistry /compact routing", () => {
  test("/compact invokes the channel compact handler for the routed conversation", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const compactCalls: unknown[] = [];
    const registry = new ChannelRegistry();
    const delivered: unknown[] = [];
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setCompactHandler(async (params) => {
      compactCalls.push(params);
      return { handled: true, text: "Compaction completed." };
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
      text: "/compact sliding_window",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
    });

    expect(delivered).toHaveLength(0);
    expect(compactCalls).toEqual([
      {
        channelId: "slack",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
        args: "sliding_window",
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "Compaction completed.",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });
});
