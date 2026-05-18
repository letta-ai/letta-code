import { describe, expect, test } from "bun:test";

import {
  buildDiscordDebounceKey,
  resolveDiscordInboundDebounceMs,
} from "../channels/discord/debounce";

// ── resolveDiscordInboundDebounceMs ───────────────────────────────────

describe("resolveDiscordInboundDebounceMs", () => {
  test("returns default 1200ms when config is undefined", () => {
    expect(
      resolveDiscordInboundDebounceMs({ inboundDebounceMs: undefined }),
    ).toBe(1200);
  });

  test("returns config value when set", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 500 })).toBe(
      500,
    );
  });

  test("returns 0 when config value is 0 (disabled)", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 0 })).toBe(0);
  });

  test("clamps to 10000ms max", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 50000 })).toBe(
      10000,
    );
  });

  test("truncates fractional values", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 1500.7 })).toBe(
      1500,
    );
  });

  test("returns default for NaN config value", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: NaN })).toBe(
      1200,
    );
  });

  test("returns default for negative config value", () => {
    expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: -100 })).toBe(
      1200,
    );
  });

  test("env var takes precedence over config", () => {
    const original = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "300";
    try {
      expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 500 })).toBe(
        300,
      );
    } finally {
      if (original === undefined) {
        delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
      } else {
        process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = original;
      }
    }
  });

  test("env var 0 disables debounce", () => {
    const original = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "0";
    try {
      expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 500 })).toBe(
        0,
      );
    } finally {
      if (original === undefined) {
        delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
      } else {
        process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = original;
      }
    }
  });

  test("env var clamps to 10000ms max", () => {
    const original = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "99999";
    try {
      expect(
        resolveDiscordInboundDebounceMs({ inboundDebounceMs: undefined }),
      ).toBe(10000);
    } finally {
      if (original === undefined) {
        delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
      } else {
        process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = original;
      }
    }
  });

  test("falls back to config when env var is empty string", () => {
    const original = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "";
    try {
      expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 800 })).toBe(
        800,
      );
    } finally {
      if (original === undefined) {
        delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
      } else {
        process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = original;
      }
    }
  });

  test("falls back to config when env var is non-numeric", () => {
    const original = process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
    process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = "abc";
    try {
      expect(resolveDiscordInboundDebounceMs({ inboundDebounceMs: 800 })).toBe(
        800,
      );
    } finally {
      if (original === undefined) {
        delete process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS;
      } else {
        process.env.LETTA_DISCORD_INBOUND_DEBOUNCE_MS = original;
      }
    }
  });
});

// ── buildDiscordDebounceKey ───────────────────────────────────────────

describe("buildDiscordDebounceKey", () => {
  test("returns null when scope is empty", () => {
    expect(
      buildDiscordDebounceKey({ channelId: "", threadId: null }, "acct-1"),
    ).toBe(null);
  });

  test("keys by channelId when no thread", () => {
    expect(
      buildDiscordDebounceKey({ channelId: "ch-1", threadId: null }, "acct-1"),
    ).toBe("discord:acct-1:ch-1");
  });

  test("keys by threadId when thread is set", () => {
    expect(
      buildDiscordDebounceKey(
        { channelId: "ch-1", threadId: "thread-1" },
        "acct-1",
      ),
    ).toBe("discord:acct-1:thread-1");
  });

  test("different accounts produce different keys for same channel", () => {
    const key1 = buildDiscordDebounceKey(
      { channelId: "ch-1", threadId: null },
      "acct-1",
    );
    const key2 = buildDiscordDebounceKey(
      { channelId: "ch-1", threadId: null },
      "acct-2",
    );
    expect(key1).not.toBe(key2);
  });

  test("same key for different senders in same channel (intentional merge)", () => {
    // The key does not include senderId so that multi-sender bursts
    // in the same channel merge into one LLM call with sender labels.
    const input = { channelId: "ch-1", threadId: null };
    expect(buildDiscordDebounceKey(input, "acct-1")).toBe(
      buildDiscordDebounceKey(input, "acct-1"),
    );
  });

  test("different threads produce different keys", () => {
    const key1 = buildDiscordDebounceKey(
      { channelId: "ch-1", threadId: "thread-1" },
      "acct-1",
    );
    const key2 = buildDiscordDebounceKey(
      { channelId: "ch-1", threadId: "thread-2" },
      "acct-1",
    );
    expect(key1).not.toBe(key2);
  });

  test("different channels produce different keys", () => {
    const key1 = buildDiscordDebounceKey(
      { channelId: "ch-1", threadId: null },
      "acct-1",
    );
    const key2 = buildDiscordDebounceKey(
      { channelId: "ch-2", threadId: null },
      "acct-1",
    );
    expect(key1).not.toBe(key2);
  });
});
