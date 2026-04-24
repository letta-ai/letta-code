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
} from "../../channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "../../channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";
import type {
  ChannelAdapter,
  InboundChannelMessage,
} from "../../channels/types";

const createConversation = mock(async () => ({ id: "conv-discord" }));

mock.module("../../agent/client", () => ({
  getClient: async () => ({
    conversations: {
      create: createConversation,
    },
  }),
}));

describe("discord channel registry", () => {
  function resetState(): void {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    createConversation.mockReset();
    createConversation.mockResolvedValue({ id: "conv-discord" });
  }

  function createInboundMessage(
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "discord",
      accountId: "discord-bot",
      chatId: "thread-1",
      senderId: "user-1",
      senderName: "Cameron",
      text: "hello",
      timestamp: Date.now(),
      messageId: "msg-1",
      threadId: "thread-1",
      chatType: "channel",
      isMention: false,
      ...overrides,
    };
  }

  function createAdapter(
    replies: Array<{ chatId: string; text: string }> = [],
  ): ChannelAdapter {
    return {
      id: "discord:discord-bot",
      channelId: "discord",
      accountId: "discord-bot",
      name: "Discord",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "outbound-1" }),
      sendDirectReply: async (chatId, text) => {
        replies.push({ chatId, text });
      },
    };
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const { getChannelRegistry } = await import("../../channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    resetState();
  });

  afterAll(() => {
    mock.restore();
  });

  test("does not auto-create a route for non-mentioned traffic in an untracked thread", async () => {
    const { ChannelRegistry } = await import("../../channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage());

    expect(deliveries).toHaveLength(0);
    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).toBe(
      null,
    );
  });

  test("creates a route when first contact in an untracked thread is an explicit mention", async () => {
    const { ChannelRegistry } = await import("../../channels/registry");
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
        isMention: true,
        text: "@Loop hi",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).not.toBe(
      null,
    );
    expect(deliveries).toHaveLength(1);
  });

  test("auto-creates a direct-message route for bound open Discord accounts", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        dmPolicy: "open",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("../../channels/registry");
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
        chatId: "dm-1",
        threadId: null,
        chatType: "direct",
        isMention: false,
        messageId: "dm-msg-1",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledWith({
      agent_id: "agent-1",
      isolated_block_labels: expect.any(Array),
      summary: "[Discord] DM with Cameron",
    });
    expect(getRoute("discord", "dm-1", "discord-bot")).toMatchObject({
      accountId: "discord-bot",
      chatId: "dm-1",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-discord",
    });
    expect(deliveries).toHaveLength(1);
  });

  test("rejects direct messages from users outside a Discord allowlist", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        dmPolicy: "allowlist",
        allowedUsers: ["user-2"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("../../channels/registry");
    const registry = new ChannelRegistry();
    const replies: Array<{ chatId: string; text: string }> = [];
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "dm-1",
        threadId: null,
        chatType: "direct",
        isMention: false,
        messageId: "dm-msg-1",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("discord", "dm-1", "discord-bot")).toBe(null);
    expect(deliveries).toHaveLength(0);
    expect(replies).toEqual([
      {
        chatId: "dm-1",
        text: "You are not on the allowed users list for this Discord bot.",
      },
    ]);
  });

  test("keeps explicit Discord pairing DMs on the pairing flow", async () => {
    const { ChannelRegistry } = await import("../../channels/registry");
    const registry = new ChannelRegistry();
    const replies: Array<{ chatId: string; text: string }> = [];
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "dm-1",
        threadId: null,
        chatType: "direct",
        isMention: false,
        messageId: "dm-msg-1",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("discord", "dm-1", "discord-bot")).toBe(null);
    expect(deliveries).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain("Pairing code:");
  });
});
