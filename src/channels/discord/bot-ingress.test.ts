import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createDiscordAdapter } from "@/channels/discord/adapter";
import { __testOverrideLoadDiscordModule } from "@/channels/discord/runtime";
import type {
  ChannelAdapter,
  DiscordChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";

interface DiscordTestMessage {
  id: string;
  content: string;
  channelId: string;
  guildId: string | null;
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
    send?: (options: unknown) => Promise<{ id: string }>;
  };
  mentions: { has: (user: unknown) => boolean };
  attachments: Map<string, never>;
  createdTimestamp: number;
}

class FakeDiscordClient {
  static instances: FakeDiscordClient[] = [];

  readonly user = {
    id: "bot-user",
    username: "Loop",
    tag: "Loop#0001",
    bot: true,
  };

  readonly login = mock(async (_token: string) => {
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

  constructor(_options: { intents: unknown[]; partials?: unknown[] }) {
    FakeDiscordClient.instances.push(this);
  }

  once(event: string, handler: (...args: unknown[]) => unknown): this {
    this.onceHandlers.set(event, handler);
    return this;
  }

  on(event: string, handler: (...args: unknown[]) => unknown): this {
    this.handlers.set(event, handler);
    return this;
  }

  async emitMessageCreate(message: DiscordTestMessage): Promise<void> {
    const handler = this.handlers.get("messageCreate");
    if (!handler) {
      throw new Error("messageCreate handler was not registered");
    }
    await handler(message);
  }
}

function createFakeDiscordRuntime() {
  return {
    Client: FakeDiscordClient,
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

const discordAccountDefaults: Omit<DiscordChannelAccount, "allowedChannels"> = {
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
};

const activeAdapters: ChannelAdapter[] = [];

function createDiscordMessage(
  overrides: {
    id?: string;
    content?: string;
    channelId?: string;
    guildId?: string | null;
    parentChannelId?: string | null;
    isThread?: boolean;
    mentioned?: boolean;
    authorId?: string;
    authorUsername?: string;
    authorGlobalName?: string;
    authorBot?: boolean;
  } = {},
): DiscordTestMessage {
  const channelId = overrides.channelId ?? "channel-open";
  const authorGlobalName = overrides.authorGlobalName ?? "Cameron";
  const guildId =
    "guildId" in overrides ? (overrides.guildId ?? null) : "guild-1";
  return {
    id: overrides.id ?? `${channelId}-message`,
    content: overrides.content ?? "ambient hello",
    channelId,
    guildId,
    author: {
      id: overrides.authorId ?? "user-1",
      username: overrides.authorUsername ?? "cameron",
      globalName: authorGlobalName,
      bot: overrides.authorBot ?? false,
    },
    member: { displayName: authorGlobalName },
    channel: {
      name: channelId,
      parentId: overrides.parentChannelId ?? null,
      isThread: () => overrides.isThread ?? false,
    },
    mentions: { has: () => overrides.mentioned ?? false },
    attachments: new Map<string, never>(),
    createdTimestamp: 1712800000000,
  };
}

async function startAdapterWithDeliveries(
  allowedChannels: DiscordChannelAccount["allowedChannels"],
  accountOverrides: Partial<DiscordChannelAccount> = {},
): Promise<{
  client: FakeDiscordClient;
  deliveries: InboundChannelMessage[];
}> {
  const adapter = createDiscordAdapter({
    ...discordAccountDefaults,
    ...accountOverrides,
    allowedChannels,
  });
  activeAdapters.push(adapter);
  const deliveries: InboundChannelMessage[] = [];
  adapter.onMessage = async (message) => {
    deliveries.push(message);
  };

  await adapter.start();
  const client = FakeDiscordClient.instances.at(-1);
  if (!client) {
    throw new Error("Discord client was not created");
  }
  return { client, deliveries };
}

beforeEach(() => {
  FakeDiscordClient.instances.length = 0;
  activeAdapters.length = 0;
  __testOverrideLoadDiscordModule(async () => createFakeDiscordRuntime());
});

afterEach(async () => {
  for (const adapter of activeAdapters.splice(0)) {
    await adapter.stop();
  }
  __testOverrideLoadDiscordModule(null);
  FakeDiscordClient.instances.length = 0;
});

describe("Discord adapter bot ingress", () => {
  test("drops foreign bot guild messages by default even when mentioned", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries({
      "channel-open": "open",
    });

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-default",
        channelId: "channel-open",
        content: "<@bot-user> please loop",
        mentioned: true,
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("accepts explicitly mentioned foreign bot guild messages when enabled", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries(
      ["channel-mention"],
      { allowBots: "mentions" },
    );

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-mentioned",
        channelId: "channel-mention",
        content: "<@bot-user> investigate this",
        mentioned: true,
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      chatId: "channel-mention",
      senderId: "foreign-bot",
      senderName: "Worker Bot",
      text: "investigate this",
      isMention: true,
      isOpenChannel: false,
    });
  });

  test("does not treat Discord reply-ping metadata as a foreign bot mention", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries(
      { "channel-open": "open" },
      { allowBots: "mentions" },
    );

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-reply-ping",
        channelId: "channel-open",
        content: "reply metadata only",
        mentioned: true,
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("preserves human mention semantics when Discord reports a mention", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries([
      "channel-mention",
    ]);

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-human-reply-ping",
        channelId: "channel-mention",
        content: "reply metadata only",
        mentioned: true,
      }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      text: "reply metadata only",
      senderId: "user-1",
      isMention: true,
    });
  });

  test("always suppresses the receiving bot's own Discord messages", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries(
      { "channel-open": "open" },
      { allowBots: "mentions" },
    );

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-self-bot",
        channelId: "channel-open",
        content: "<@bot-user> self loop",
        mentioned: true,
        authorId: "bot-user",
        authorUsername: "Loop",
        authorGlobalName: "Loop",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("does not treat a Discord DM from a foreign bot as an implicit mention", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries([], {
      allowBots: "mentions",
    });

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-dm",
        channelId: "dm-1",
        guildId: null,
        content: "hello in dm",
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("accepts explicitly mentioned foreign bot DMs when enabled", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries([], {
      allowBots: "mentions",
    });

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-dm-mentioned",
        channelId: "dm-1",
        guildId: null,
        content: "<@bot-user> hello in dm",
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      chatId: "dm-1",
      chatType: "direct",
      senderId: "foreign-bot",
      senderName: "Worker Bot",
      text: "<@bot-user> hello in dm",
      isMention: false,
    });
  });

  test("does not treat thread participation as an implicit foreign bot mention", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries(
      { "parent-open": "open" },
      { allowBots: "mentions" },
    );

    await client.emitMessageCreate(
      createDiscordMessage({
        id: "msg-bot-thread",
        channelId: "thread-1",
        parentChannelId: "parent-open",
        isThread: true,
        content: "thread follow-up",
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("does not send delivery-failure replies to bot-authored guild messages", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: { "channel-open": "open" },
      allowBots: "mentions",
    });
    activeAdapters.push(adapter);
    adapter.onMessage = async () => {
      throw new Error("bot delivery failed");
    };

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      await adapter.start();
      const client = FakeDiscordClient.instances.at(-1);
      if (!client) {
        throw new Error("Discord client was not created");
      }
      const send = mock(async (_options: unknown) => ({ id: "error-reply" }));
      const message = createDiscordMessage({
        id: "msg-bot-error",
        channelId: "channel-open",
        content: "<@bot-user> crash",
        mentioned: true,
        authorId: "foreign-bot",
        authorUsername: "workerbot",
        authorGlobalName: "Worker Bot",
        authorBot: true,
      });
      message.channel.send = send;

      await client.emitMessageCreate(message);

      expect(send).not.toHaveBeenCalled();
    } finally {
      console.error = originalConsoleError;
    }
  });
});
