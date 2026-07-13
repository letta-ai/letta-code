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
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelInboundDelivery } from "@/channels/registry-handlers";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";
import type { ChannelAdapter } from "@/channels/types";

function configureTelegramAccount(params?: {
  dmPolicy?: "open" | "allowlist" | "pairing";
  allowedUsers?: string[];
}): void {
  __testOverrideLoadChannelAccounts(() => [
    {
      channel: "telegram",
      accountId: "acct-telegram",
      enabled: true,
      token: "test-token",
      dmPolicy: params?.dmPolicy ?? "open",
      allowedUsers: params?.allowedUsers ?? [],
      binding: { agentId: null, conversationId: null },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
  ]);
  __testOverrideSaveChannelAccounts(() => {});
}

function configureSlackAccount(params?: {
  dmPolicy?: "open" | "allowlist" | "pairing";
  allowedUsers?: string[];
}): void {
  __testOverrideLoadChannelAccounts(() => [
    {
      channel: "slack",
      accountId: "acct-slack",
      enabled: true,
      mode: "socket",
      botToken: "xoxb-test",
      appToken: "xapp-test",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
      dmPolicy: params?.dmPolicy ?? "open",
      allowedUsers: params?.allowedUsers ?? [],
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
  ]);
  __testOverrideSaveChannelAccounts(() => {});
}

function makeAdapter(params: {
  channelId: string;
  accountId: string;
  replies: Array<{ chatId: string; text: string; replyToMessageId?: string }>;
}): ChannelAdapter {
  return {
    id: `${params.channelId}:${params.accountId}`,
    channelId: params.channelId,
    accountId: params.accountId,
    name: params.channelId,
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async (chatId, text, options) => {
      params.replies.push({
        chatId,
        text,
        replyToMessageId: options?.replyToMessageId,
      });
    },
    onMessage: undefined,
  };
}

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

describe("ChannelRegistry /letta escape hatch", () => {
  test("routes /letta listener commands through the exact enabled channel route", async () => {
    configureTelegramAccount();
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: `ran ${params.commandId} ${params.args}` };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );
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
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(executeCalls).toEqual([
      {
        commandId: "compact",
        args: "all",
        text: "/compact all",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "123",
        text: "ran compact all",
        replyToMessageId: "77",
      },
    ]);
  });

  test("does not execute /letta commands without an exact enabled route", async () => {
    configureTelegramAccount();
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: "unused" };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(executeCalls).toHaveLength(0);
    expect(replies[0]).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
    });
    expect(replies[0]?.text).toContain(
      "Telegram could not find an existing route for this chat.",
    );
  });

  test("does not let a Slack root-channel route catch unmentioned thread /letta commands", async () => {
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: "unused" };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "slack",
        accountId: "acct-slack",
        replies,
      }),
    );
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
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    });

    expect(executeCalls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  test("does not execute /letta commands for a disabled route", async () => {
    configureTelegramAccount();
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: "unused" };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );
    addRoute("telegram", {
      accountId: "acct-telegram",
      chatId: "123",
      chatType: "direct",
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: false,
      createdAt: "2026-05-19T00:00:00.000Z",
    });

    const adapter = registry.getAdapter("telegram", "acct-telegram");
    await adapter?.onMessage?.({
      channel: "telegram",
      accountId: "acct-telegram",
      chatId: "123",
      senderId: "456",
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(executeCalls).toHaveLength(0);
    expect(replies[0]?.text).toContain(
      "Telegram could not find an existing route for this chat.",
    );
  });

  test("does not execute /letta commands for an unauthorized sender", async () => {
    configureTelegramAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["allowed"],
    });
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: "unused" };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );
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
      senderId: "blocked",
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(executeCalls).toHaveLength(0);
    expect(delivered).toHaveLength(0);
    expect(replies).toEqual([
      {
        chatId: "123",
        text: "You are not on the allowed users list for this bot.",
        replyToMessageId: undefined,
      },
    ]);
  });

  test("does not apply DM allowlist policy to routed channel /letta commands", async () => {
    configureSlackAccount({
      dmPolicy: "allowlist",
      allowedUsers: ["U_ALLOWED"],
    });
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const executeCalls: unknown[] = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setExecuteCommandHandler(async (params) => {
      executeCalls.push(params);
      return { handled: true, text: "ran from channel route" };
    });
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "slack",
        accountId: "acct-slack",
        replies,
      }),
    );
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
      senderId: "U_BLOCKED",
      text: "/letta /compact all",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
    });

    expect(delivered).toHaveLength(0);
    expect(executeCalls).toEqual([
      {
        commandId: "compact",
        args: "all",
        text: "/compact all",
        runtime: {
          agent_id: "agent-1",
          conversation_id: "conv-1",
        },
      },
    ]);
    expect(replies).toEqual([
      {
        chatId: "C123",
        text: "ran from channel route",
        replyToMessageId: "1712800000.000200",
      },
    ]);
  });

  test("reports unavailable listener command handler without falling through to agent delivery", async () => {
    configureTelegramAccount();
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );
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
      text: "/letta /reload",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(delivered).toHaveLength(0);
    expect(replies[0]?.text).toContain(
      "Telegram cannot use /letta because the listener command handler is not ready yet.",
    );
  });

  test("strips /letta from plain text and delivers the message normally", async () => {
    configureTelegramAccount();
    const replies: Array<{ chatId: string; text: string }> = [];
    const delivered: ChannelInboundDelivery[] = [];
    const registry = new ChannelRegistry();
    registry.setMessageHandler((delivery) => delivered.push(delivery));
    registry.setReady();
    registry.registerAdapter(
      makeAdapter({
        channelId: "telegram",
        accountId: "acct-telegram",
        replies,
      }),
    );
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
      text: "/letta hello from channel",
      timestamp: Date.now(),
      messageId: "77",
      chatType: "direct",
    });

    expect(replies).toHaveLength(0);
    expect(delivered).toHaveLength(1);
    expect(JSON.stringify(delivered[0]?.content)).toContain(
      "hello from channel",
    );
    expect(JSON.stringify(delivered[0]?.content)).not.toContain("/letta");
  });
});
