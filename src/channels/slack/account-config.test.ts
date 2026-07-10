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
