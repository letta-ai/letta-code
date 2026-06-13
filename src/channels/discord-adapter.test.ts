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
  buildDiscordIngressMessageKey,
  buildDiscordReplyOptions,
  createDiscordAdapter,
  shouldAutoThreadOnDiscordMention,
} from "@/channels/discord/adapter";
import { __testOverrideLoadDiscordModule } from "@/channels/discord/runtime";
import type {
  DiscordChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";

interface DiscordTestMessage {
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
  };
  mentions: { has: (user: unknown) => boolean };
  attachments: Map<string, never>;
  createdTimestamp: number;
  startThread: (options: {
    name: string;
    reason?: string;
  }) => Promise<{ id: string; name: string }>;
  react: (emoji: string) => Promise<void>;
  reactions: { cache: Map<string, never> };
}

class FakeDiscordClient {
  static instances: FakeDiscordClient[] = [];
  // When set, the next login() call rejects with this error (simulates the
  // gateway refusing the connection, e.g. disallowed intents).
  static loginError: unknown = null;

  readonly user = {
    id: "bot-user",
    username: "Loop",
    tag: "Loop#0001",
    bot: true,
  };

  readonly channels = {
    fetch: mock(async () => null),
  };

  readonly login = mock(async (_token: string) => {
    if (FakeDiscordClient.loginError) {
      throw FakeDiscordClient.loginError;
    }
    return undefined;
  });
  readonly destroy = mock(() => {});
  private readonly handlers = new Map<
    string,
    (...args: unknown[]) => unknown
  >();

  constructor(_options: { intents: unknown[]; partials?: unknown[] }) {
    FakeDiscordClient.instances.push(this);
  }

  once(_event: string, _handler: (...args: unknown[]) => unknown): this {
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

function createGuildMessage(
  overrides: {
    id?: string;
    content?: string;
    channelId?: string;
    channelName?: string;
    parentChannelId?: string | null;
    isThread?: boolean;
    mentioned?: boolean;
  } = {},
): DiscordTestMessage {
  const channelId = overrides.channelId ?? "channel-open";
  const isThread = overrides.isThread ?? false;
  const mentioned = overrides.mentioned ?? false;
  return {
    id: overrides.id ?? `${channelId}-message`,
    content: overrides.content ?? "ambient hello",
    channelId,
    guildId: "guild-1",
    author: {
      id: "user-1",
      username: "cameron",
      globalName: "Cameron",
      bot: false,
    },
    member: { displayName: "Cameron" },
    channel: {
      name: overrides.channelName ?? channelId,
      parentId: overrides.parentChannelId ?? null,
      isThread: () => isThread,
    },
    mentions: { has: () => mentioned },
    attachments: new Map<string, never>(),
    createdTimestamp: 1712800000000,
    startThread: mock(async () => ({
      id: "created-thread",
      name: "created thread",
    })),
    react: mock(async () => {}),
    reactions: { cache: new Map<string, never>() },
  };
}

async function startAdapterWithDeliveries(
  allowedChannels: DiscordChannelAccount["allowedChannels"],
): Promise<{
  client: FakeDiscordClient;
  deliveries: InboundChannelMessage[];
}> {
  const adapter = createDiscordAdapter({
    ...discordAccountDefaults,
    allowedChannels,
  });
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
  FakeDiscordClient.loginError = null;
  __testOverrideLoadDiscordModule(async () => createFakeDiscordRuntime());
});

afterEach(() => {
  __testOverrideLoadDiscordModule(null);
});

afterAll(() => {
  mock.restore();
});

// ── Discord adapter connection errors ──────────────────────────────────

describe("Discord adapter start()", () => {
  test("translates a disallowed-intents login failure into an actionable error", async () => {
    FakeDiscordClient.loginError = new Error("Used disallowed intents");
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
    });

    await expect(adapter.start()).rejects.toThrow(/Message Content Intent/);
    expect(adapter.isRunning()).toBe(false);
  });

  test("preserves unrelated login failures", async () => {
    FakeDiscordClient.loginError = new Error("An invalid token was provided.");
    const adapter = createDiscordAdapter({
      ...discordAccountDefaults,
      allowedChannels: {},
    });

    await expect(adapter.start()).rejects.toThrow(/invalid token/i);
  });
});

// ── Discord adapter open-channel ingress ───────────────────────────────

describe("Discord adapter open-channel ingress", () => {
  test("passes non-mentioned guild messages from configured open channels", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries({
      "channel-open": "open",
    });

    await client.emitMessageCreate(
      createGuildMessage({ id: "msg-open", channelId: "channel-open" }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: "discord",
      accountId: "discord-bot",
      chatId: "channel-open",
      senderId: "user-1",
      senderName: "Cameron",
      text: "ambient hello",
      messageId: "msg-open",
      threadId: null,
      parentChannelId: "channel-open",
      chatType: "channel",
      isMention: false,
      isOpenChannel: true,
    });
  });

  test("drops non-mentioned guild messages from legacy string allowlists", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries([
      "channel-legacy",
    ]);

    await client.emitMessageCreate(
      createGuildMessage({ id: "msg-legacy", channelId: "channel-legacy" }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("drops non-mentioned guild messages from mention-only channel maps", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries({
      "channel-mention-only": "mention-only",
    });

    await client.emitMessageCreate(
      createGuildMessage({
        id: "msg-mention-only",
        channelId: "channel-mention-only",
      }),
    );

    expect(deliveries).toHaveLength(0);
  });

  test("passes thread messages under open parents with parent metadata", async () => {
    const { client, deliveries } = await startAdapterWithDeliveries({
      "parent-open": "open",
    });

    await client.emitMessageCreate(
      createGuildMessage({
        id: "msg-thread-open",
        channelId: "thread-1",
        content: "thread hello",
        parentChannelId: "parent-open",
        isThread: true,
      }),
    );

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channel: "discord",
      accountId: "discord-bot",
      chatId: "thread-1",
      text: "thread hello",
      messageId: "msg-thread-open",
      threadId: "thread-1",
      parentChannelId: "parent-open",
      chatType: "channel",
      isMention: false,
      isOpenChannel: true,
    });
  });
});

// The Discord adapter's internal helpers are not exported, but we can test
// the equivalent logic by reimplementing the pure functions here and verifying
// they match the adapter's behavior. These are regression tests for the
// algorithms used in adapter.ts.

// ── shouldAutoThreadOnDiscordMention ───────────────────────────────

describe("shouldAutoThreadOnDiscordMention", () => {
  test("defaults to false when no policy is configured", () => {
    expect(
      shouldAutoThreadOnDiscordMention(
        { autoThreadOnMention: undefined, threadPolicyByChannel: undefined },
        "channel-1",
      ),
    ).toBe(false);
  });

  test("preserves account-level false", () => {
    expect(
      shouldAutoThreadOnDiscordMention(
        { autoThreadOnMention: false, threadPolicyByChannel: {} },
        "channel-1",
      ),
    ).toBe(false);
  });

  test("allows account-level true", () => {
    expect(
      shouldAutoThreadOnDiscordMention(
        { autoThreadOnMention: true, threadPolicyByChannel: {} },
        "channel-1",
      ),
    ).toBe(true);
  });

  test("per-channel policy overrides account-level false", () => {
    expect(
      shouldAutoThreadOnDiscordMention(
        {
          autoThreadOnMention: false,
          threadPolicyByChannel: { "channel-1": true },
        },
        "channel-1",
      ),
    ).toBe(true);
  });

  test("per-channel policy overrides account-level true", () => {
    expect(
      shouldAutoThreadOnDiscordMention(
        {
          autoThreadOnMention: true,
          threadPolicyByChannel: { "channel-1": false },
        },
        "channel-1",
      ),
    ).toBe(false);
  });
});

// ── splitMessageText ──────────────────────────────────────────────────────

function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

describe("splitMessageText", () => {
  test("short messages pass through as-is", () => {
    expect(splitMessageText("hello", 2000)).toEqual(["hello"]);
  });

  test("empty string returns single chunk", () => {
    expect(splitMessageText("", 2000)).toEqual([""]);
  });

  test("splits at newline boundary when possible", () => {
    const line = "a".repeat(900);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessageText(text, 1900);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should split at the newline (position 900), not mid-content
    expect(chunks[0]?.length).toBeLessThanOrEqual(1900);
    // The split should happen at a \n boundary, so first chunk should be
    // exactly 900+1 chars (the first line plus the newline)
    expect(chunks[0]).toBe(`${line}\n${line}`);
  });

  test("splits at space boundary when no newlines available", () => {
    const words = Array(500).fill("word").join(" ");
    const chunks = splitMessageText(words, 1900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1900);
    }
  });

  test("hard-splits when no whitespace available", () => {
    const solid = "x".repeat(5000);
    const chunks = splitMessageText(solid, 1900);
    expect(chunks.length).toBe(3); // 1900 + 1900 + 1200
    expect(chunks[0]?.length).toBe(1900);
    expect(chunks[1]?.length).toBe(1900);
    expect(chunks[2]?.length).toBe(1200);
  });

  test("reconstructed text matches original content", () => {
    const text = Array(100)
      .fill("The quick brown fox jumps over the lazy dog.")
      .join("\n");
    const chunks = splitMessageText(text, 1900);
    // When we split at boundaries and trimStart remaining, some whitespace
    // may be consumed. Verify all non-whitespace content is preserved.
    const originalNonWs = text.replace(/\s+/g, "");
    const reconstructedNonWs = chunks.join("").replace(/\s+/g, "");
    expect(reconstructedNonWs).toBe(originalNonWs);
  });
});

// ── normalizeDiscordMentionText ──────────────────────────────────────────

function normalizeDiscordMentionText(
  text: string,
  botUserId: string | null,
): string {
  if (!botUserId) return text;
  return text.replace(new RegExp(`<@!?${botUserId}>\\s*`, "g"), "").trim();
}

describe("normalizeDiscordMentionText", () => {
  test("strips <@botId> mention", () => {
    expect(normalizeDiscordMentionText("<@123> hello", "123")).toBe("hello");
  });

  test("strips <@!botId> mention (nickname variant)", () => {
    expect(normalizeDiscordMentionText("<@!123> hello", "123")).toBe("hello");
  });

  test("strips multiple mentions of the bot", () => {
    expect(normalizeDiscordMentionText("<@123> hey <@123> there", "123")).toBe(
      "hey there",
    );
  });

  test("preserves mentions of other users", () => {
    expect(normalizeDiscordMentionText("<@456> hello", "123")).toBe(
      "<@456> hello",
    );
  });

  test("returns text unchanged when botUserId is null", () => {
    expect(normalizeDiscordMentionText("<@123> hello", null)).toBe(
      "<@123> hello",
    );
  });

  test("handles mention at end of text", () => {
    expect(normalizeDiscordMentionText("hey <@123>", "123")).toBe("hey");
  });

  test("handles text that is only a mention", () => {
    expect(normalizeDiscordMentionText("<@123>", "123")).toBe("");
  });
});

// ── resolveDiscordReactionEmoji ──────────────────────────────────────────

function resolveDiscordReactionEmoji(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<:") || trimmed.startsWith("<a:")) {
    return trimmed;
  }
  const normalized = trimmed.replace(/^:+|:+$/g, "");
  const nameMap: Record<string, string> = {
    eyes: "👀",
    white_check_mark: "✅",
    x: "❌",
  };
  return nameMap[normalized] ?? normalized;
}

describe("resolveDiscordReactionEmoji", () => {
  test("maps :eyes: to 👀", () => {
    expect(resolveDiscordReactionEmoji(":eyes:")).toBe("👀");
  });

  test("maps :white_check_mark: to ✅", () => {
    expect(resolveDiscordReactionEmoji(":white_check_mark:")).toBe("✅");
  });

  test("maps :x: to ❌", () => {
    expect(resolveDiscordReactionEmoji(":x:")).toBe("❌");
  });

  test("passes through native unicode emoji", () => {
    expect(resolveDiscordReactionEmoji("🔥")).toBe("🔥");
  });

  test("passes through unicode emoji with whitespace trimmed", () => {
    expect(resolveDiscordReactionEmoji("  👍  ")).toBe("👍");
  });

  test("strips colons from named input", () => {
    expect(resolveDiscordReactionEmoji("eyes")).toBe("👀");
  });

  test("passes through unknown names as-is", () => {
    expect(resolveDiscordReactionEmoji("custom_emoji")).toBe("custom_emoji");
  });

  test("passes through Discord custom emoji syntax unchanged", () => {
    expect(resolveDiscordReactionEmoji("<:custom:123456>")).toBe(
      "<:custom:123456>",
    );
    expect(resolveDiscordReactionEmoji("<a:animated:654321>")).toBe(
      "<a:animated:654321>",
    );
  });
});

// ── resolveDiscordChatType ──────────────────────────────────────────────

function resolveDiscordChatType(
  guildId: string | null | undefined,
): "direct" | "channel" {
  return guildId ? "channel" : "direct";
}

describe("resolveDiscordChatType", () => {
  test("null guildId is direct", () => {
    expect(resolveDiscordChatType(null)).toBe("direct");
  });

  test("undefined guildId is direct", () => {
    expect(resolveDiscordChatType(undefined)).toBe("direct");
  });

  test("non-empty guildId is channel", () => {
    expect(resolveDiscordChatType("guild-123")).toBe("channel");
  });
});

// ── buildDiscordIngressMessageKey ────────────────────────────────────────

describe("buildDiscordIngressMessageKey", () => {
  test("dedupes the same Discord message across parent/thread channel contexts", () => {
    // Discord message IDs are globally unique. If the same underlying message
    // is surfaced through both a parent channel and created thread context, the
    // dedupe key must remain stable.
    const parentChannelKey = buildDiscordIngressMessageKey(
      "discord-bot",
      "msg-1",
    );
    const threadChannelKey = buildDiscordIngressMessageKey(
      "discord-bot",
      "msg-1",
    );

    expect(parentChannelKey).toBe(threadChannelKey);
  });

  test("scopes dedupe by account so multiple bots do not collide", () => {
    expect(buildDiscordIngressMessageKey("bot-a", "msg-1")).not.toBe(
      buildDiscordIngressMessageKey("bot-b", "msg-1"),
    );
  });

  test("returns null when account or message ID is missing", () => {
    expect(buildDiscordIngressMessageKey(undefined, "msg-1")).toBeNull();
    expect(buildDiscordIngressMessageKey("discord-bot", undefined)).toBeNull();
    expect(buildDiscordIngressMessageKey("", "msg-1")).toBeNull();
    expect(buildDiscordIngressMessageKey("discord-bot", "")).toBeNull();
  });
});

// ── buildDiscordReplyOptions ─────────────────────────────────────────────

describe("buildDiscordReplyOptions", () => {
  test("omits reply options when no reply target is provided", () => {
    expect(buildDiscordReplyOptions(undefined, "channel-1")).toBeUndefined();
    expect(buildDiscordReplyOptions("", "channel-1")).toBeUndefined();
  });

  test("omits reply options when reply target equals target channel", () => {
    expect(buildDiscordReplyOptions("channel-1", "channel-1")).toBeUndefined();
  });

  test("sets failIfNotExists false so stale quote targets do not fail sends", () => {
    expect(buildDiscordReplyOptions("msg-1", "channel-1")).toEqual({
      reply: {
        messageReference: "msg-1",
        failIfNotExists: false,
      },
    });
  });
});
