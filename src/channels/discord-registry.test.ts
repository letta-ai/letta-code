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
import { createDiscordAdapter } from "@/channels/discord/adapter";
import { __testOverrideLoadDiscordModule } from "@/channels/discord/runtime";
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
import type {
  ChannelAdapter,
  DiscordChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";

const createConversation = mock(async () => ({ id: "conv-discord" }));

interface DiscordIntegrationMessage {
  id: string;
  content: string;
  channelId: string;
  guildId: string;
  author: {
    id: string;
    username: string;
    globalName: string;
    bot: boolean;
  };
  member: { displayName: string };
  channel: {
    name: string;
    parentId: string | null;
    isThread: () => boolean;
    send: (options: Record<string, unknown>) => Promise<{ id: string }>;
  };
  mentions: { has: (user: unknown) => boolean };
  attachments: Map<string, never>;
  createdTimestamp: number;
  startThread: () => Promise<{ id: string; name: string }>;
  react: () => Promise<void>;
  reactions: { cache: Map<string, never> };
}

class DiscordIntegrationClient {
  static instances: DiscordIntegrationClient[] = [];
  static threadReplies: Record<string, unknown>[] = [];

  readonly user = {
    id: "bot-user",
    username: "Loop",
    tag: "Loop#0001",
    bot: true,
  };
  readonly channels = {
    fetch: async (id: string) => ({
      isTextBased: () => id === "created-thread",
      send: async (options: Record<string, unknown>) => {
        DiscordIntegrationClient.threadReplies.push(options);
        return { id: "thread-reply" };
      },
    }),
  };
  readonly login = mock(async () => {
    await this.onceHandlers.get("ready")?.();
  });
  readonly destroy = mock(() => {});
  private readonly handlers = new Map<
    string,
    (...args: unknown[]) => unknown
  >();
  private readonly onceHandlers = new Map<
    string,
    (...args: unknown[]) => unknown
  >();

  constructor() {
    DiscordIntegrationClient.instances.push(this);
  }

  once(event: string, handler: (...args: unknown[]) => unknown): this {
    this.onceHandlers.set(event, handler);
    return this;
  }

  on(event: string, handler: (...args: unknown[]) => unknown): this {
    this.handlers.set(event, handler);
    return this;
  }

  async emitMessageCreate(message: DiscordIntegrationMessage): Promise<void> {
    await this.handlers.get("messageCreate")?.(message);
  }
}

function createDiscordIntegrationRuntime() {
  return {
    Client: DiscordIntegrationClient,
    GatewayIntentBits: {
      Guilds: "Guilds",
      GuildMessages: "GuildMessages",
      GuildMessageReactions: "GuildMessageReactions",
      MessageContent: "MessageContent",
      DirectMessages: "DirectMessages",
      DirectMessageReactions: "DirectMessageReactions",
    },
    Partials: {
      Channel: "Channel",
      Message: "Message",
      Reaction: "Reaction",
      User: "User",
    },
  };
}

function createDiscordIntegrationMessage(options: {
  id: string;
  content: string;
  channelId: string;
  parentChannelId: string | null;
  isThread: boolean;
  parentReplies: Record<string, unknown>[];
}): DiscordIntegrationMessage {
  return {
    id: options.id,
    content: options.content,
    channelId: options.channelId,
    guildId: "guild-1",
    author: {
      id: "user-1",
      username: "cameron",
      globalName: "Cameron",
      bot: false,
    },
    member: { displayName: "Cameron" },
    channel: {
      name: options.channelId,
      parentId: options.parentChannelId,
      isThread: () => options.isThread,
      send: async (reply) => {
        options.parentReplies.push(reply);
        return { id: "parent-reply" };
      },
    },
    mentions: { has: () => true },
    attachments: new Map<string, never>(),
    createdTimestamp: Date.now(),
    startThread: async () => ({
      id: "created-thread",
      name: "created thread",
    }),
    react: async () => {},
    reactions: { cache: new Map<string, never>() },
  };
}

mock.module("@/backend/api/client", () => ({
  getServerUrl: () => "https://api.letta.com",
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
    __testOverrideLoadDiscordModule(null);
    DiscordIntegrationClient.instances.length = 0;
    DiscordIntegrationClient.threadReplies.length = 0;
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
        defaultPermissionMode: "standard",
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
    const { getChannelRegistry } = await import("@/channels/registry");
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

    expect(deliveries).toHaveLength(0);
    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).toBe(
      null,
    );
  });

  test("creates a route when first contact in an untracked thread is an explicit mention", async () => {
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

  test("recovers a Discord auto-thread through the raw adapter boundary after route provisioning fails", async () => {
    const account: DiscordChannelAccount = {
      channel: "discord",
      accountId: "discord-bot",
      enabled: true,
      token: "discord-token",
      agentId: "agent-1",
      defaultPermissionMode: "standard",
      dmPolicy: "pairing",
      allowedUsers: [],
      autoThreadOnMention: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    };
    __testOverrideLoadDiscordModule(async () =>
      createDiscordIntegrationRuntime(),
    );

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createDiscordAdapter(account);
    registry.registerAdapter(adapter);
    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();
    await adapter.start();

    const client = DiscordIntegrationClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const parentReplies: Record<string, unknown>[] = [];
    createConversation.mockRejectedValueOnce({
      status: 401,
      message: "Unauthorized",
    });

    await client.emitMessageCreate(
      createDiscordIntegrationMessage({
        id: "parent-mention",
        content: "<@bot-user> start",
        channelId: "parent-channel",
        parentChannelId: null,
        isThread: false,
        parentReplies,
      }),
    );

    expect(
      getRoute("discord", "created-thread", "discord-bot", "created-thread"),
    ).toBeNull();
    expect(parentReplies).toHaveLength(1);
    expect(parentReplies[0]?.content).toContain(
      "my Letta API credentials were rejected",
    );

    await client.emitMessageCreate(
      createDiscordIntegrationMessage({
        id: "bare-thread-mention",
        content: "<@bot-user>",
        channelId: "created-thread",
        parentChannelId: "parent-channel",
        isThread: true,
        parentReplies,
      }),
    );

    expect(
      getRoute("discord", "created-thread", "discord-bot", "created-thread"),
    ).not.toBeNull();
    expect(deliveries).toHaveLength(0);
    expect(DiscordIntegrationClient.threadReplies).toEqual([
      {
        content:
          "This thread is connected now. Send a message here to continue.",
        reply: {
          messageReference: "bare-thread-mention",
          failIfNotExists: false,
        },
      },
    ]);
  });

  test("recovers an untracked thread from a bare explicit mention without starting an empty turn", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const replies: Array<{ chatId: string; text: string }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).not.toBe(
      null,
    );
    expect(deliveries).toHaveLength(0);
    expect(replies).toEqual([
      {
        chatId: "thread-1",
        text: "This thread is connected now. Send a message here to continue.",
      },
    ]);
  });

  test("diagnoses a bare mention in an existing route without starting an empty turn", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const replies: Array<{ chatId: string; text: string }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "first message",
      }),
    );
    deliveries.length = 0;
    replies.length = 0;
    createConversation.mockClear();

    await adapter.onMessage?.(
      createInboundMessage({
        messageId: "msg-2",
        isMention: true,
        text: "",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
    expect(replies).toEqual([
      {
        chatId: "thread-1",
        text: "This thread is already connected. Send a message here to continue.",
      },
    ]);
  });

  test("creates a route for policy-permitted open-channel traffic without marking it as a mention", async () => {
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
        isMention: false,
        isOpenChannel: true,
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("discord", "thread-1", "discord-bot", "thread-1")).not.toBe(
      null,
    );
    expect(deliveries).toHaveLength(1);
  });

  test("does not spam setup replies for unbound ambient open-channel traffic", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: null,
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const replies: Array<{ chatId: string; text: string }> = [];
    const registry = new ChannelRegistry();
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        isMention: false,
        isOpenChannel: true,
      }),
    );

    expect(replies).toHaveLength(0);
    expect(createConversation).not.toHaveBeenCalled();
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
        defaultPermissionMode: "standard",
        dmPolicy: "open",
        allowedUsers: [],
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
    expect(createConversation).toHaveBeenCalledWith(
      {
        agent_id: "agent-1",
        summary: "DM with Cameron",
      },
      undefined,
    );
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

  test("emits standard permission mode when Discord creates a conversation", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "open",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);
    const events: unknown[] = [];
    registry.setEventHandler((event) => events.push(event));
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

    expect(events).toContainEqual({
      type: "discord_conversation_created",
      channelId: "discord",
      accountId: "discord-bot",
      agentId: "agent-1",
      conversationId: "conv-discord",
      defaultPermissionMode: "standard",
    });
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
        defaultPermissionMode: "standard",
        dmPolicy: "allowlist",
        allowedUsers: ["user-2"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
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

  test("admin users pass the Discord DM allowlist and auto-route", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "allowlist",
        allowedUsers: ["user-2"],
        adminUsers: ["user-1"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
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

    expect(replies).toHaveLength(0);
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("discord", "dm-1", "discord-bot")).not.toBe(null);
    expect(deliveries).toHaveLength(1);
  });

  test("keeps explicit Discord pairing DMs on the pairing flow with the account agent", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
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
    expect(replies[0]?.text).toContain(
      "letta channels pair --channel discord --code",
    );
    expect(replies[0]?.text).toContain("--agent agent-1");
    expect(replies[0]?.text).not.toContain("--agent <agent-id>");
    expect(replies[0]?.text).not.toContain(
      "Find your agent id with letta agents list.",
    );
  });

  // ── Delivery-time gate (allowed_channels re-check) ─────────────

  test("delivery-time gate passes thread-on-mention with correct parentChannelId", async () => {
    // Simulates a mention in guild-channel "alpha" where the adapter
    // creates a thread and sets parentChannelId to the guild channel.
    // The delivery-time gate should resolve alpha → allowed.
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    // Override account with allowedChannels that includes the guild channel
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: ["alpha"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    // This is what the adapter sends after creating a thread for
    // a mention in guild channel "alpha":
    //   chatId = thread ID
    //   threadId = thread ID (both same — "thread-1")
    //   parentChannelId = "alpha" (the original guild channel)
    //   isMention = true
    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "thread-1",
        threadId: "thread-1",
        parentChannelId: "alpha",
        chatType: "channel",
        isMention: true,
        messageId: "mention-msg-1",
      }),
    );

    // Route should be created and message delivered
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(
      getRoute("discord", "thread-1", "discord-bot", "thread-1"),
    ).not.toBeNull();
    expect(deliveries).toHaveLength(1);
  });

  test("delivery-time gate blocks thread-on-mention when parent channel is not allowed", async () => {
    // Same as above but the guild channel is NOT in allowedChannels.
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        allowedChannels: ["alpha"],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    // Guild channel "blocked-channel" is not in allowedChannels
    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "thread-2",
        threadId: "thread-2",
        parentChannelId: "blocked-channel",
        chatType: "channel",
        isMention: true,
        messageId: "mention-msg-2",
      }),
    );

    // Route should still be created (ensureDiscordRoute happens before
    // the gate check), but the message should NOT be delivered
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(
      getRoute("discord", "thread-2", "discord-bot", "thread-2"),
    ).not.toBeNull();
    expect(deliveries).toHaveLength(0);
  });

  test("delivery-time gate passes thread-on-mention when allowedChannels is not configured", async () => {
    // When allowedChannels is not configured, the gate is skipped.
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    // Restore default account (no allowedChannels)
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "discord",
        accountId: "discord-bot",
        enabled: true,
        token: "discord-token",
        agentId: "agent-1",
        defaultPermissionMode: "standard",
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "thread-3",
        threadId: "thread-3",
        parentChannelId: "any-channel",
        chatType: "channel",
        isMention: true,
        messageId: "mention-msg-3",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
  });
});
