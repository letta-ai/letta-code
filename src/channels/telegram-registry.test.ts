import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
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
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";

const createConversation = mock(async () => ({ id: "conv-telegram" }));

mock.module("@/backend/api/client", () => ({
  getServerUrl: () => "https://api.letta.com",
  getClient: async () => ({
    conversations: {
      create: createConversation,
    },
  }),
}));

describe("telegram channel registry", () => {
  function resetState(): void {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
    createConversation.mockReset();
    createConversation.mockResolvedValue({ id: "conv-telegram" });
  }

  function createInboundMessage(
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "telegram",
      accountId: "telegram-bot",
      chatId: "-100123",
      senderId: "user-1",
      senderName: "Cameron",
      chatLabel: "Void Cafe",
      text: "hello topic",
      timestamp: Date.now(),
      messageId: "msg-1",
      threadId: "42",
      chatType: "channel",
      ...overrides,
    };
  }

  function createAdapter(
    replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
    }> = [],
  ): ChannelAdapter {
    return {
      id: "telegram:telegram-bot",
      channelId: "telegram",
      accountId: "telegram-bot",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "outbound-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
        });
      },
    };
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  });

  afterEach(async () => {
    const { getChannelRegistry } = await import("@/channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    resetState();
  });

  test("mention-only Telegram groups ignore ambient messages", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        groupMode: "mention-only",
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage({ isMention: false }));

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toBeNull();
    expect(deliveries).toHaveLength(0);
  });

  test("mention-only Telegram groups route explicit mentions", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        groupMode: "mention-only",
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage({ isMention: true }));

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toMatchObject(
      {
        accountId: "telegram-bot",
        agentId: "agent-1",
      },
    );
    expect(deliveries).toHaveLength(1);
  });

  afterAll(() => {
    mock.restore();
  });

  test("auto-creates a route per Telegram forum topic for bound group traffic", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage());

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledWith(
      {
        agent_id: "agent-1",
        summary: "[Telegram] Topic in Void Cafe: hello topic",
      },
      undefined,
    );
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toMatchObject(
      {
        accountId: "telegram-bot",
        chatId: "-100123",
        chatType: "channel",
        threadId: "42",
        agentId: "agent-1",
        conversationId: "conv-telegram",
      },
    );
    expect(deliveries).toHaveLength(1);
  });

  test("keeps Telegram direct messages on the pairing route", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "123",
        chatLabel: undefined,
        chatType: "direct",
        threadId: null,
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("telegram", "123", "telegram-bot")).toBeNull();
    expect(deliveries).toHaveLength(0);
  });
});
