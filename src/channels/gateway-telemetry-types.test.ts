import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { resolveChannelGatewayTelemetryTypes } from "@/channels/gateway-telemetry-types";
import { createChannelAccountLive } from "@/channels/service";
import type { ChannelAccount } from "@/channels/types";

// Stands in for the on-disk account files shared by the listener and the
// ChannelGateway child.
const disk = new Map<string, ChannelAccount[]>();

function resetAccountStores(): void {
  clearChannelAccountStores();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
}

beforeEach(() => {
  resetAccountStores();
  disk.clear();
  __testOverrideLoadChannelAccounts((channelId) => disk.get(channelId) ?? []);
  __testOverrideSaveChannelAccounts((channelId, accounts) => {
    disk.set(channelId, accounts);
  });
});

afterEach(() => {
  resetAccountStores();
});

test("explicit --channels telemetry uses the provided channel names", () => {
  expect(
    resolveChannelGatewayTelemetryTypes({
      restoreEnabledChannels: false,
      channelNames: ["telegram", "discord"],
    }),
  ).toEqual(["telegram", "discord"]);
});

test("Desktop restore telemetry enumerates enabled accounts when channelNames is empty", () => {
  createChannelAccountLive(
    "telegram",
    {
      displayName: "Telegram Bot",
      enabled: true,
      token: "telegram-token",
      dmPolicy: "pairing",
    },
    { accountId: "telegram-1" },
  );
  createChannelAccountLive(
    "slack",
    {
      displayName: "Slack App",
      enabled: false,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      dmPolicy: "pairing",
    },
    { accountId: "slack-1" },
  );

  expect(
    resolveChannelGatewayTelemetryTypes({
      restoreEnabledChannels: true,
      channelNames: [],
      restoreAgentScope: "all",
    }),
  ).toEqual(["telegram"]);
});

test("Desktop restore telemetry reflects account changes made by the gateway child", () => {
  createChannelAccountLive(
    "telegram",
    {
      displayName: "Telegram Bot",
      enabled: true,
      token: "telegram-token",
      dmPolicy: "pairing",
    },
    { accountId: "telegram-1" },
  );

  expect(
    resolveChannelGatewayTelemetryTypes({
      restoreEnabledChannels: true,
      channelNames: [],
    }),
  ).toEqual(["telegram"]);

  // The child disables the account: disk changes, but this process's account
  // cache is never touched.
  disk.set(
    "telegram",
    (disk.get("telegram") ?? []).map((account) => ({
      ...account,
      enabled: false,
    })),
  );

  expect(
    resolveChannelGatewayTelemetryTypes({
      restoreEnabledChannels: true,
      channelNames: [],
    }),
  ).toEqual([]);
});
