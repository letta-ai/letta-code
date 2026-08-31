import { describe, expect, test } from "bun:test";
import { feishuAccountConfigAdapter } from "@/channels/feishu/account-config";
import type { FeishuChannelAccount } from "@/channels/types";

function account(
  overrides: Partial<FeishuChannelAccount> = {},
): FeishuChannelAccount {
  return {
    channel: "feishu",
    accountId: "acct-1",
    enabled: true,
    appId: "cli_app",
    appSecret: "super-secret",
    domain: "feishu",
    groupMode: "mention-only",
    agentId: "agent-1",
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("feishu account config", () => {
  test("unknown config keys are invalid", () => {
    expect(feishuAccountConfigAdapter.isValidConfig({ webhook_url: "x" })).toBe(
      false,
    );
    expect(
      feishuAccountConfigAdapter.isValidConfig({ domain: "https://evil" }),
    ).toBe(false);
    expect(
      feishuAccountConfigAdapter.isValidConfig({
        app_id: "cli_app",
        domain: "lark",
      }),
    ).toBe(true);
  });

  test("app_secret is redacted in list/get snapshots", () => {
    const snapshot = feishuAccountConfigAdapter.toAccountConfig(account());
    expect(snapshot.has_app_secret).toBe(true);
    expect(snapshot.app_secret).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain("super-secret");
    expect(snapshot.app_id).toBe("cli_app");
    expect(snapshot.domain).toBe("feishu");
    expect(snapshot.group_mode).toBe("mention-only");
  });

  test("empty secret is reported as missing", () => {
    const snapshot = feishuAccountConfigAdapter.toAccountConfig(
      account({ appSecret: "  " }),
    );
    expect(snapshot.has_app_secret).toBe(false);
  });
});
