import { describe, expect, test } from "bun:test";

import { isDiscordGuildChannelAllowed } from "../channels/discord/channelGating";

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
});
