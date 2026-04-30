import { describe, expect, test } from "bun:test";
import {
  buildDiscordDebounceKey,
  type DiscordDebounceEntry,
  mergeDiscordDebouncedEntries,
  resolveDiscordInboundDebounceMs,
} from "../../channels/discord/adapter";
import type { InboundChannelMessage } from "../../channels/types";

const ACCOUNT = "acct-1";

describe("buildDiscordDebounceKey", () => {
  test("DMs are channel-scoped (two messages from same user in same DM share a key)", () => {
    const k1 = buildDiscordDebounceKey(
      { channelId: "dm-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    const k2 = buildDiscordDebounceKey(
      { channelId: "dm-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    expect(k1).not.toBeNull();
    expect(k1).toBe(k2);
  });

  test("DMs from different users produce different keys", () => {
    const k1 = buildDiscordDebounceKey(
      { channelId: "dm-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    const k2 = buildDiscordDebounceKey(
      { channelId: "dm-1", threadId: null, senderId: "user-2" },
      ACCOUNT,
    );
    expect(k1).not.toBe(k2);
  });

  test("top-level guild messages from same sender share a key", () => {
    const k1 = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    const k2 = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    expect(k1).toBe(k2);
  });

  test("thread replies are thread-scoped (same channel, different threads → different keys)", () => {
    const k1 = buildDiscordDebounceKey(
      {
        channelId: "channel-1",
        threadId: "thread-a",
        senderId: "user-1",
      },
      ACCOUNT,
    );
    const k2 = buildDiscordDebounceKey(
      {
        channelId: "channel-1",
        threadId: "thread-b",
        senderId: "user-1",
      },
      ACCOUNT,
    );
    expect(k1).not.toBe(k2);
  });

  test("thread replies do not collide with parent-channel posts", () => {
    const threadKey = buildDiscordDebounceKey(
      {
        channelId: "channel-1",
        threadId: "thread-a",
        senderId: "user-1",
      },
      ACCOUNT,
    );
    const parentKey = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    expect(threadKey).not.toBe(parentKey);
  });

  test("returns null when sender is missing", () => {
    const key = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "" },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });

  test("returns null when channelId is missing", () => {
    const key = buildDiscordDebounceKey(
      { channelId: "", threadId: null, senderId: "user-1" },
      ACCOUNT,
    );
    expect(key).toBeNull();
  });

  test("accountId scopes the key (different accounts → different keys)", () => {
    const k1 = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "user-1" },
      "acct-a",
    );
    const k2 = buildDiscordDebounceKey(
      { channelId: "channel-1", threadId: null, senderId: "user-1" },
      "acct-b",
    );
    expect(k1).not.toBe(k2);
  });
});

describe("mergeDiscordDebouncedEntries", () => {
  function makeEntry(
    overrides: Partial<InboundChannelMessage> & { wasMentioned?: boolean } = {},
  ): DiscordDebounceEntry {
    const { wasMentioned, ...inboundOverrides } = overrides;
    return {
      raw: { channelId: "channel-1", threadId: null, senderId: "user-1" },
      wasMentioned: wasMentioned ?? false,
      inbound: {
        channel: "discord",
        accountId: "acct-1",
        chatId: "channel-1",
        senderId: "user-1",
        text: "",
        timestamp: 0,
        chatType: "channel",
        isMention: false,
        ...inboundOverrides,
      },
    };
  }

  test("returns null for empty entries", () => {
    expect(mergeDiscordDebouncedEntries([])).toBeNull();
  });

  test("single entry passes through unchanged", () => {
    const entry = makeEntry({ text: "hello", messageId: "m-1" });
    const merged = mergeDiscordDebouncedEntries([entry]);
    expect(merged?.text).toBe("hello");
    expect(merged?.messageId).toBe("m-1");
  });

  test("multiple entries collapse text with newline join", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "hey", messageId: "m-1" }),
      makeEntry({ text: "quick question", messageId: "m-2" }),
      makeEntry({ text: "about the plan", messageId: "m-3" }),
    ]);
    expect(merged?.text).toBe("hey\nquick question\nabout the plan");
  });

  test("empty-text entries are skipped during text join", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "first" }),
      makeEntry({ text: "" }),
      makeEntry({ text: "third" }),
    ]);
    expect(merged?.text).toBe("first\nthird");
  });

  test("merged message uses last entry's IDs / timestamp / raw", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "a", messageId: "m-1", timestamp: 1000 }),
      makeEntry({
        text: "b",
        messageId: "m-2",
        timestamp: 2000,
        raw: { sentinel: "last" },
      }),
    ]);
    expect(merged?.messageId).toBe("m-2");
    expect(merged?.timestamp).toBe(2000);
    expect(merged?.raw).toEqual({ sentinel: "last" });
  });

  test("isMention OR-folds across the burst (mention buried in middle surfaces)", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "a", isMention: false }),
      makeEntry({ text: "b", isMention: true }),
      makeEntry({ text: "c", isMention: false }),
    ]);
    expect(merged?.isMention).toBe(true);
  });

  test("isMention OR-folds via wasMentioned flag (when inbound.isMention is unset)", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "a", wasMentioned: false }),
      makeEntry({ text: "b", wasMentioned: true }),
    ]);
    expect(merged?.isMention).toBe(true);
  });

  test("isMention stays false when no entry was mentioned", () => {
    const merged = mergeDiscordDebouncedEntries([
      makeEntry({ text: "a" }),
      makeEntry({ text: "b" }),
    ]);
    expect(merged?.isMention).toBe(false);
  });
});

describe("resolveDiscordInboundDebounceMs", () => {
  const originalEnv = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;

  function clearEnv() {
    delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
  }

  function restoreEnv() {
    if (originalEnv === undefined) clearEnv();
    else process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = originalEnv;
  }

  test("defaults to 0 when no env var and no config value", () => {
    clearEnv();
    expect(resolveDiscordInboundDebounceMs({})).toBe(0);
    restoreEnv();
  });

  test("returns config value when env is unset", () => {
    clearEnv();
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      1500,
    );
    restoreEnv();
  });

  test("env var overrides config", () => {
    clearEnv();
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "2500";
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      2500,
    );
    restoreEnv();
  });

  test("env var of 0 is respected (disables debounce even with config set)", () => {
    clearEnv();
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "0";
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 1500 })).toBe(
      0,
    );
    restoreEnv();
  });

  test("invalid env var falls back to config", () => {
    clearEnv();
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "not-a-number";
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 800 })).toBe(
      800,
    );
    restoreEnv();
  });

  test("negative config value falls back to 0", () => {
    clearEnv();
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: -500 })).toBe(
      0,
    );
    restoreEnv();
  });

  test("empty-string env var is treated as unset", () => {
    clearEnv();
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "";
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 1234 })).toBe(
      1234,
    );
    restoreEnv();
  });
});
