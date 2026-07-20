import { describe, expect, test } from "bun:test";
import type { DiscordChannelAccount } from "@/channels/types";
import { discordAccountConfigAdapter } from "./account-config";

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
});
