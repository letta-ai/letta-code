import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { resolveChannelGatewayTelemetryTypes } from "@/channels/gateway-telemetry-types";
import { createChannelAccountLive } from "@/channels/service";

function resetAccountStores(): void {
  clearChannelAccountStores();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
}

beforeEach(() => {
  resetAccountStores();
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
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

test("Desktop restore telemetry re-reads enabled accounts at emit time", () => {
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

  createChannelAccountLive(
    "discord",
    {
      displayName: "Discord Bot",
      enabled: true,
      token: "discord-token",
      dmPolicy: "pairing",
    },
    { accountId: "discord-1" },
  );

  expect(
    resolveChannelGatewayTelemetryTypes({
      restoreEnabledChannels: true,
      channelNames: [],
    }),
  ).toEqual(["telegram", "discord"]);
});
