import { describe, expect, test } from "bun:test";

import {
  isDiscordGuildChannelAllowed,
  resolveDiscordChannelMode,
} from "../channels/discord/channelGating";

// ── isDiscordGuildChannelAllowed (legacy string[]) ─────────────────────

describe("isDiscordGuildChannelAllowed", () => {
  test("returns true when allowedChannels is undefined", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "123",
        parentChannelId: null,
        isThread: false,
      }),
    ).toBe(true);
  });

  test("returns true when allowedChannels is an empty array", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "123",
        parentChannelId: null,
        isThread: false,
        allowedChannels: [],
      }),
    ).toBe(true);
  });

  test("returns true for non-thread message in an allowed channel", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "allowed-1",
        parentChannelId: null,
        isThread: false,
        allowedChannels: ["allowed-1", "allowed-2"],
      }),
    ).toBe(true);
  });

  test("returns false for non-thread message in a disallowed channel", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "blocked",
        parentChannelId: null,
        isThread: false,
        allowedChannels: ["allowed-1"],
      }),
    ).toBe(false);
  });

  test("thread message uses parent channel ID for the allow check", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "thread-xyz",
        parentChannelId: "allowed-1",
        isThread: true,
        allowedChannels: ["allowed-1"],
      }),
    ).toBe(true);
  });

  test("thread message in a disallowed parent channel is blocked", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "thread-xyz",
        parentChannelId: "blocked",
        isThread: true,
        allowedChannels: ["allowed-1"],
      }),
    ).toBe(false);
  });

  test("thread message with null parent falls back to its own channel ID", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "thread-no-parent",
        parentChannelId: null,
        isThread: true,
        allowedChannels: ["thread-no-parent"],
      }),
    ).toBe(true);
  });

  test("thread message with null parent and no self-match is blocked", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "thread-no-parent",
        parentChannelId: null,
        isThread: true,
        allowedChannels: ["allowed-1"],
      }),
    ).toBe(false);
  });

  // ── Mode map format ────────────────────────────────────────────────

  test("returns true for channel in mode map", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "ch-open",
        parentChannelId: null,
        isThread: false,
        allowedChannels: { "ch-open": "open", "ch-mention": "mention-only" },
      }),
    ).toBe(true);
  });

  test("returns false for channel not in mode map", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "ch-unknown",
        parentChannelId: null,
        isThread: false,
        allowedChannels: { "ch-open": "open" },
      }),
    ).toBe(false);
  });

  test("returns true when mode map is empty", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "123",
        parentChannelId: null,
        isThread: false,
        allowedChannels: {},
      }),
    ).toBe(true);
  });

  test("thread message resolves parent channel from mode map", () => {
    expect(
      isDiscordGuildChannelAllowed({
        channelId: "thread-xyz",
        parentChannelId: "ch-open",
        isThread: true,
        allowedChannels: { "ch-open": "open" },
      }),
    ).toBe(true);
  });
});

// ── resolveDiscordChannelMode ──────────────────────────────────────────

describe("resolveDiscordChannelMode", () => {
  test("returns null when allowedChannels is undefined", () => {
    expect(resolveDiscordChannelMode("123", null, false)).toBe(null);
  });

  test("returns null when allowedChannels is an empty array", () => {
    expect(resolveDiscordChannelMode("123", null, false, [])).toBe(null);
  });

  test("returns 'mention-only' for channel in legacy string array", () => {
    expect(
      resolveDiscordChannelMode("ch-1", null, false, ["ch-1", "ch-2"]),
    ).toBe("mention-only");
  });

  test("returns null for channel not in legacy string array", () => {
    expect(
      resolveDiscordChannelMode("ch-unknown", null, false, ["ch-1"]),
    ).toBe(null);
  });

  test("returns 'open' for channel set to open in mode map", () => {
    expect(
      resolveDiscordChannelMode("ch-open", null, false, {
        "ch-open": "open",
        "ch-mention": "mention-only",
      }),
    ).toBe("open");
  });

  test("returns 'mention-only' for channel set to mention-only in mode map", () => {
    expect(
      resolveDiscordChannelMode("ch-mention", null, false, {
        "ch-open": "open",
        "ch-mention": "mention-only",
      }),
    ).toBe("mention-only");
  });

  test("returns null for channel not in mode map", () => {
    expect(
      resolveDiscordChannelMode("ch-unknown", null, false, {
        "ch-open": "open",
      }),
    ).toBe(null);
  });

  test("returns null when mode map is empty", () => {
    expect(resolveDiscordChannelMode("ch-1", null, false, {})).toBe(null);
  });

  test("thread message resolves mode from parent channel", () => {
    expect(
      resolveDiscordChannelMode("thread-xyz", "ch-open", true, {
        "ch-open": "open",
      }),
    ).toBe("open");
  });

  test("thread with null parent falls back to own channel ID", () => {
    expect(
      resolveDiscordChannelMode("thread-self", null, true, {
        "thread-self": "mention-only",
      }),
    ).toBe("mention-only");
  });
});
