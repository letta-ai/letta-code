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
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
} from "@/channels/routing";

function installPairingPolicyAccount() {
  __testOverrideLoadChannelAccounts(() => [
    {
      channel: "telegram",
      accountId: "acct-telegram",
      enabled: true,
      token: "test-token",
      dmPolicy: "pairing",
      allowedUsers: [],
      binding: { agentId: null, conversationId: null },
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
    },
  ]);
  __testOverrideSaveChannelAccounts(() => {});
}

function addStatusRoute() {
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
}

async function runStatusCommand() {
  const replies: Array<{
    chatId: string;
    text: string;
    replyToMessageId?: string;
  }> = [];
  const delivered: unknown[] = [];
  const modelStatusCalls: unknown[] = [];
  const registry = new ChannelRegistry();

  registry.setMessageHandler((delivery) => delivered.push(delivery));
  registry.setModelHandler(null, async (params) => {
    modelStatusCalls.push(params);
    return {
      modelLabel: "GPT-5.6 Sol",
      modelHandle: "openai/gpt-5.6-sol",
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

  return { delivered, modelStatusCalls, replies };
}

describe("ChannelRegistry /status pairing access", () => {
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

  test("pending-pairing /status omits runtime model details", async () => {
    installPairingPolicyAccount();
    addStatusRoute();

    const { delivered, modelStatusCalls, replies } = await runStatusCommand();

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
    expect(replies[0]?.text).not.toContain("Model:");
    expect(replies[0]?.text).not.toContain("GPT-5.6 Sol");
    expect(replies[0]?.text).not.toContain("openai/gpt-5.6-sol");
    expect(modelStatusCalls).toEqual([]);
  });

  test("paired /status includes runtime model details under pairing policy", async () => {
    installPairingPolicyAccount();
    __testOverrideLoadPairingStore(() => ({
      pending: [],
      approved: [
        {
          accountId: "acct-telegram",
          senderId: "456",
          senderName: "Alice",
          approvedAt: "2026-05-14T00:00:00.000Z",
        },
      ],
    }));
    addStatusRoute();

    const { delivered, modelStatusCalls, replies } = await runStatusCommand();

    expect(delivered).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain(
      "Model: GPT-5.6 Sol (openai/gpt-5.6-sol).",
    );
    expect(modelStatusCalls).toEqual([
      {
        agentId: "agent-status",
        conversationId: "conv-status",
      },
    ]);
  });
});
