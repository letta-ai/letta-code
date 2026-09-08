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
  clearAllRoutes,
  getRoutesForChannel,
} from "@/channels/routing";

describe("Slack commands in unrouted threads", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "acct-slack",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "open",
        allowedUsers: [],
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        createdAt: "2026-09-08T00:00:00.000Z",
        updatedAt: "2026-09-08T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) await registry.stopAll();
    clearAllRoutes();
    clearChannelAccountStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test("handles a command before the thread has an agent route", async () => {
    const replies: string[] = [];
    const delivered: unknown[] = [];
    const registry = new ChannelRegistry();
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
      sendDirectReply: async (_chatId, text) => {
        replies.push(text);
      },
      onMessage: undefined,
    });

    const adapter = registry.getAdapter("slack", "acct-slack");
    const baseMessage = {
      channel: "slack" as const,
      accountId: "acct-slack",
      chatId: "C123",
      senderId: "U123",
      senderName: "Charles",
      timestamp: Date.now(),
      threadId: "1788902178.048049",
      chatType: "channel" as const,
    };

    await adapter?.onMessage?.({
      ...baseMessage,
      text: "/help",
      messageId: "1788902179.000001",
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Slack is connected to Letta Code");
    expect(delivered).toHaveLength(0);
    expect(getRoutesForChannel("slack", "acct-slack")).toHaveLength(0);

    await adapter?.onMessage?.({
      ...baseMessage,
      text: "ordinary thread reply",
      messageId: "1788902180.000001",
    });

    expect(replies).toHaveLength(1);
    expect(delivered).toHaveLength(0);
    expect(getRoutesForChannel("slack", "acct-slack")).toHaveLength(0);
  });
});
