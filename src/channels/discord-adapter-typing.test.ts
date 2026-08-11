import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createDiscordAdapter } from "@/channels/discord/adapter";
import { __testOverrideLoadDiscordModule } from "@/channels/discord/runtime";
import type {
  ChannelTurnSource,
  DiscordChannelAccount,
} from "@/channels/types";

class FakeDiscordClient {
  static instances: FakeDiscordClient[] = [];

  readonly user = {
    id: "bot-user",
    username: "Loop",
    tag: "Loop#0001",
    bot: true,
  };

  readonly channels = {
    fetch: mock(async (_id: string): Promise<unknown> => null),
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

function createFetchedDiscordMessage() {
  return {
    id: "msg-1",
    react: mock(async (_emoji: string) => undefined),
    reactions: {
      cache: new Map<string, never>(),
      resolve: mock((_emoji: string) => null),
    },
  };
}

function createTextChannel(
  message: ReturnType<
    typeof createFetchedDiscordMessage
  > = createFetchedDiscordMessage(),
) {
  return {
    isTextBased: () => true,
    sendTyping: mock(async () => undefined),
    send: mock(async (_options: string | Record<string, unknown>) => ({
      id: "sent-message",
    })),
    messages: {
      fetch: mock(async (_id: string) => message),
    },
  };
}

function createTurnSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "discord",
    accountId: "discord-bot",
    chatId: "channel-1",
    chatType: "direct",
    messageId: "msg-1",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  };
}

beforeEach(() => {
  FakeDiscordClient.instances.length = 0;
  __testOverrideLoadDiscordModule(async () => createFakeDiscordRuntime());
});

afterEach(() => {
  __testOverrideLoadDiscordModule(null);
});

afterAll(() => {
  mock.restore();
});

describe("Discord adapter lifecycle feedback", () => {
  test("owns typing from queue acceptance through completion", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();

    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const channel = createTextChannel();
    client.channels.fetch.mockImplementation(async () => channel);
    const source = createTurnSource();

    await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });
    expect(client.channels.fetch).toHaveBeenCalledWith("channel-1");
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [source],
      outcome: "completed",
      stopReason: "end_turn",
    });
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-2",
      sources: [source],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  test("keeps lifecycle ownership after sending a message", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();

    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const channel = createTextChannel();
    client.channels.fetch.mockImplementation(async () => channel);
    const source = createTurnSource();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.sendMessage({
      channel: "discord",
      accountId: "discord-bot",
      chatId: "channel-1",
      text: "done",
    });
    expect(channel.send).toHaveBeenCalledWith({ content: "done" });

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [source],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  test("reference-counts queued sources for the same target", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();
    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const channel = createTextChannel();
    client.channels.fetch.mockImplementation(async () => channel);
    const first = createTurnSource();
    const second = { ...first, messageId: "message-2" };

    await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: first });
    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: second,
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [first],
      outcome: "completed",
      stopReason: "end_turn",
    });
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-2",
      sources: [second],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  test("cancelled releases typing and sibling source keeps it active", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();
    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const channel = createTextChannel();
    client.channels.fetch.mockImplementation(async () => channel);
    const first = createTurnSource({ messageId: "msg-1" });
    const second = createTurnSource({ messageId: "msg-2" });

    await adapter.handleTurnLifecycleEvent?.({ type: "queued", source: first });
    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: second,
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [first],
      outcome: "cancelled",
      stopReason: "cancelled",
    });
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-2",
      sources: [second],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-2",
      sources: [second],
      outcome: "cancelled",
      stopReason: "cancelled",
    });
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-3",
      sources: [second],
    });
    expect(channel.sendTyping).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });

  test("failed initial typing does not wipe sibling owners added during await", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();
    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");

    let releaseFirstTyping: (() => void) | undefined;
    const firstTypingGate = new Promise<void>((resolve) => {
      releaseFirstTyping = resolve;
    });
    let sendTypingCalls = 0;
    const channel = {
      ...createTextChannel(),
      sendTyping: mock(async () => {
        sendTypingCalls += 1;
        if (sendTypingCalls === 1) {
          await firstTypingGate;
          throw new Error("initial typing failed");
        }
      }),
    };
    client.channels.fetch.mockImplementation(async () => channel);

    const first = createTurnSource({ messageId: "msg-1" });
    const second = createTurnSource({ messageId: "msg-2" });

    const firstQueued = adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: first,
    });
    for (let i = 0; i < 20 && sendTypingCalls < 1; i += 1) {
      await Bun.sleep(0);
    }
    expect(sendTypingCalls).toBe(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: second,
    });
    releaseFirstTyping?.();
    await firstQueued;

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [first],
      outcome: "cancelled",
      stopReason: "cancelled",
    });
    const callsAfterCancel = channel.sendTyping.mock.calls.length;
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-2",
      sources: [second],
    });
    expect(channel.sendTyping.mock.calls.length).toBe(callsAfterCancel);

    await adapter.stop();
  });

  test("does not send lifecycle reactions unless opted in", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: false,
    });
    await adapter.start();

    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const message = createFetchedDiscordMessage();
    client.channels.fetch.mockImplementation(async () =>
      createTextChannel(message),
    );
    const source = createTurnSource();

    await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [source],
      outcome: "completed",
      stopReason: "end_turn",
    });

    expect(message.react).not.toHaveBeenCalled();
    await adapter.stop();
  });

  test("sends lifecycle reactions when opted in", async () => {
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
      acknowledgeMessageReaction: true,
    });
    await adapter.start();

    const client = FakeDiscordClient.instances.at(-1);
    if (!client) throw new Error("Discord client was not created");
    const message = createFetchedDiscordMessage();
    const channel = createTextChannel(message);
    client.channels.fetch.mockImplementation(async () => channel);
    const source = createTurnSource();

    await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      sources: [source],
      outcome: "completed",
      stopReason: "end_turn",
    });

    expect(message.react).toHaveBeenNthCalledWith(1, "👀");
    expect(message.react).toHaveBeenNthCalledWith(2, "✅");
    await adapter.stop();
  });
});
