import { describe, expect, test } from "bun:test";
import type { SlackChannelAccount } from "@/channels/types";
import { slackAccountConfigAdapter } from "./account-config";

const baseAccount: SlackChannelAccount = {
  channel: "slack",
  accountId: "acct-1",
  enabled: true,
  mode: "socket",
  botToken: "xoxb-test-token",
  appToken: "xapp-test-token",
  dmPolicy: "pairing",
  allowedUsers: [],
  agentId: null,
  defaultPermissionMode: "standard",
  createdAt: "2026-07-07T00:00:00.000Z",
  updatedAt: "2026-07-07T00:00:00.000Z",
};

describe("slackAccountConfigAdapter allow_bots", () => {
  test("accepts and normalizes safe bot ingress modes", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({ allow_bots: "mentions" }),
    ).toBe(true);
    expect(
      slackAccountConfigAdapter.toAccountPatch({ allow_bots: false }),
    ).toMatchObject({ allowBots: false });
    expect(
      slackAccountConfigAdapter.toAccountPatch({ allow_bots: "mentions" }),
    ).toMatchObject({ allowBots: "mentions" });
  });

  test("rejects unsafe or invalid bot ingress modes", () => {
    expect(slackAccountConfigAdapter.isValidConfig({ allow_bots: true })).toBe(
      false,
    );
    expect(slackAccountConfigAdapter.isValidConfig({ allow_bots: "all" })).toBe(
      false,
    );
    expect(slackAccountConfigAdapter.isValidConfig({ allow_bots: "off" })).toBe(
      false,
    );
    expect(
      slackAccountConfigAdapter.isValidConfig({ allow_bots: "threads" }),
    ).toBe(false);
  });

  test("surfaces allow_bots in redacted config snapshots", () => {
    expect(
      slackAccountConfigAdapter.toAccountConfig({
        ...baseAccount,
        allowBots: "mentions",
      }).allow_bots,
    ).toBe("mentions");
    expect(
      slackAccountConfigAdapter.toAccountConfig(baseAccount).allow_bots,
    ).toBe(false);
  });
});

describe("slackAccountConfigAdapter mention_only_channels", () => {
  test("accepts and maps Slack channel ID lists", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({
        mention_only_channels: ["C123", "C456"],
      }),
    ).toBe(true);
    expect(
      slackAccountConfigAdapter.toAccountPatch({
        mention_only_channels: ["C123", "C456"],
      }),
    ).toMatchObject({ mentionOnlyChannels: ["C123", "C456"] });
  });

  test("rejects invalid channel ID lists", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({
        mention_only_channels: "C123",
      }),
    ).toBe(false);
    expect(
      slackAccountConfigAdapter.isValidConfig({
        mention_only_channels: ["C123", 42],
      }),
    ).toBe(false);
  });

  test("surfaces channel IDs in redacted config snapshots", () => {
    const account = {
      ...baseAccount,
      mentionOnlyChannels: ["C123"],
    };
    expect(
      slackAccountConfigAdapter.toAccountConfig(account).mention_only_channels,
    ).toEqual(["C123"]);
    expect(
      slackAccountConfigAdapter.toConfigSnapshotConfig(account)
        .mention_only_channels,
    ).toEqual(["C123"]);
    expect(
      slackAccountConfigAdapter.toAccountConfig(baseAccount)
        .mention_only_channels,
    ).toEqual([]);
  });
});

describe("slackAccountConfigAdapter removed settings", () => {
  test("rejects the removed progress_ui setting", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({ progress_ui: "rich" }),
    ).toBe(false);
    expect(
      slackAccountConfigAdapter.toAccountConfig(baseAccount).progress_ui,
    ).toBeUndefined();
  });
});
