import { describe, expect, test } from "bun:test";

import { slackAccountConfigAdapter } from "@/channels/slack/account-config";
import type { SlackChannelAccount } from "@/channels/types";

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

describe("slackAccountConfigAdapter progress_ui", () => {
  test("accepts rich, text, and undefined", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({ progress_ui: "rich" }),
    ).toBe(true);
    expect(
      slackAccountConfigAdapter.isValidConfig({ progress_ui: "text" }),
    ).toBe(true);
    expect(slackAccountConfigAdapter.isValidConfig({})).toBe(true);
  });

  test("rejects unknown progress_ui values", () => {
    expect(
      slackAccountConfigAdapter.isValidConfig({ progress_ui: "fancy" }),
    ).toBe(false);
    expect(slackAccountConfigAdapter.isValidConfig({ progress_ui: 1 })).toBe(
      false,
    );
  });

  test("maps progress_ui into the account patch", () => {
    expect(
      slackAccountConfigAdapter.toAccountPatch({ progress_ui: "text" })
        .progressUi,
    ).toBe("text");
    expect(
      slackAccountConfigAdapter.toAccountPatch({}).progressUi,
    ).toBeUndefined();
  });

  test("emits progress_ui in config views, defaulting to rich", () => {
    expect(
      slackAccountConfigAdapter.toAccountConfig(baseAccount).progress_ui,
    ).toBe("rich");
    expect(
      slackAccountConfigAdapter.toAccountConfig({
        ...baseAccount,
        progressUi: "text",
      }).progress_ui,
    ).toBe("text");
    expect(
      slackAccountConfigAdapter.toConfigSnapshotConfig({
        ...baseAccount,
        progressUi: "text",
      }).progress_ui,
    ).toBe("text");
  });
});
