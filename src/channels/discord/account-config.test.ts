import { describe, expect, test } from "bun:test";
import type { DiscordChannelAccount } from "@/channels/types";
import { discordAccountConfigAdapter } from "./account-config";
import {
  DISCORD_OBSERVER_MAX_FLUSH_INTERVAL_MS,
  normalizeDiscordObserverConfig,
} from "./observer-config";

function makeDiscordAccount(
  overrides: Partial<DiscordChannelAccount> = {},
): DiscordChannelAccount {
  return {
    channel: "discord",
    accountId: "discord-main",
    displayName: "Discord Main",
    enabled: true,
    token: "discord-token",
    agentId: null,
    defaultPermissionMode: "standard",
    dmPolicy: "pairing",
    allowedUsers: [],
    allowedChannels: { "channel-open": "open" },
    autoThreadOnMention: false,
    threadPolicyByChannel: {},
    acknowledgeMessageReaction: false,
    removeStaleRoutes: false,
    allowBots: false,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("discordAccountConfigAdapter", () => {
  test("accepts only the guarded allow_bots modes", () => {
    expect(
      discordAccountConfigAdapter.isValidConfig({ allow_bots: false }),
    ).toBe(true);
    expect(
      discordAccountConfigAdapter.isValidConfig({ allow_bots: "mentions" }),
    ).toBe(true);

    expect(
      discordAccountConfigAdapter.isValidConfig({ allow_bots: true }),
    ).toBe(false);
    expect(
      discordAccountConfigAdapter.isValidConfig({ allow_bots: "all" }),
    ).toBe(false);
    expect(
      discordAccountConfigAdapter.isValidConfig({ allow_bots: null }),
    ).toBe(false);
  });

  test("round-trips allow_bots through account patches and snapshots", () => {
    expect(
      discordAccountConfigAdapter.toAccountPatch({ allow_bots: "mentions" }),
    ).toEqual(expect.objectContaining({ allowBots: "mentions" }));
    expect(
      discordAccountConfigAdapter.toAccountPatch({ allow_bots: false }),
    ).toEqual(expect.objectContaining({ allowBots: false }));

    expect(
      discordAccountConfigAdapter.toAccountConfig(
        makeDiscordAccount({ allowBots: "mentions" }),
      ),
    ).toEqual(expect.objectContaining({ allow_bots: "mentions" }));
    expect(
      discordAccountConfigAdapter.toConfigSnapshotConfig(makeDiscordAccount()),
    ).toEqual(expect.objectContaining({ allow_bots: false }));
  });

  test("validates and deep-clones Discord observer configuration", () => {
    const observer = {
      guildId: "guild-1",
      targets: [
        { agentId: "agent-alpha", conversationId: "default" },
        { agentId: "agent-beta", conversationId: "conv-beta" },
      ],
      flushIntervalMs: 600_000,
      maxMessages: 200,
      maxCharacters: 100_000,
      includeBots: true,
    };
    expect(discordAccountConfigAdapter.isValidConfig({ observer })).toBe(true);
    expect(
      discordAccountConfigAdapter.isValidConfig({
        observer: { ...observer, targets: [] },
      }),
    ).toBe(false);
    expect(
      discordAccountConfigAdapter.isValidConfig({
        observer: { ...observer, flushIntervalMs: 0 },
      }),
    ).toBe(false);
    expect(
      discordAccountConfigAdapter.isValidConfig({
        observer: {
          ...observer,
          flushIntervalMs: DISCORD_OBSERVER_MAX_FLUSH_INTERVAL_MS + 1,
        },
      }),
    ).toBe(false);

    const patch = discordAccountConfigAdapter.toAccountPatch({ observer });
    expect(patch.observer).toEqual(observer);
    expect(patch.observer).not.toBe(observer);
    expect(patch.observer?.targets).not.toBe(observer.targets);

    expect(
      discordAccountConfigAdapter.toAccountConfig(
        makeDiscordAccount({ observer }),
      ),
    ).toEqual(expect.objectContaining({ observer }));
    expect(
      discordAccountConfigAdapter.toAccountPatch({ observer: null }).observer,
    ).toBeNull();
    expect(
      normalizeDiscordObserverConfig({ guildId: "broken" }),
    ).toBeUndefined();
  });
});
