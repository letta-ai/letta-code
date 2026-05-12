import { describe, expect, test } from "bun:test";
import { customAccountConfigAdapter } from "../../channels/custom/accountConfig";
import type { CustomChannelAccount } from "../../channels/types";

function makeAccount(
  config: Record<string, unknown>,
  overrides: Partial<CustomChannelAccount> = {},
): CustomChannelAccount {
  return {
    channel: "custom",
    accountId: "acct-1",
    displayName: "My Custom App",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config,
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-06T00:00:00.000Z",
    ...overrides,
  };
}

describe("customAccountConfigAdapter.isValidConfig", () => {
  test("accepts the documented keys", () => {
    expect(
      customAccountConfigAdapter.isValidConfig({
        url: "https://example.com/webhook",
        bot_token: "secret",
        auth: "Bearer xyz",
        agent_id: "agent-1",
        accounts_json: "[]",
        configs_json: "{}",
      }),
    ).toBe(true);
  });

  test("accepts empty config", () => {
    expect(customAccountConfigAdapter.isValidConfig({})).toBe(true);
  });

  test("accepts null agent_id", () => {
    expect(customAccountConfigAdapter.isValidConfig({ agent_id: null })).toBe(
      true,
    );
  });

  test("rejects unknown keys", () => {
    expect(
      customAccountConfigAdapter.isValidConfig({ url: "x", extra: "y" }),
    ).toBe(false);
  });

  test("rejects wrong types", () => {
    expect(customAccountConfigAdapter.isValidConfig({ url: 42 })).toBe(false);
    expect(
      customAccountConfigAdapter.isValidConfig({ accounts_json: {} }),
    ).toBe(false);
    expect(customAccountConfigAdapter.isValidConfig({ agent_id: 7 })).toBe(
      false,
    );
  });
});

describe("customAccountConfigAdapter.toAccountConfig", () => {
  test("redacts tokens and surfaces has_* flags", () => {
    const account = makeAccount({
      url: "https://example.com/webhook",
      bot_token: "secret-token",
      auth: "Bearer xyz",
      agent_id: "agent-123",
      accounts_json: "[1,2,3]",
      configs_json: '{"a":1}',
    });

    expect(customAccountConfigAdapter.toAccountConfig(account)).toEqual({
      url: "https://example.com/webhook",
      has_bot_token: true,
      has_auth: true,
      agent_id: "agent-123",
      accounts_json: "[1,2,3]",
      configs_json: '{"a":1}',
    });
  });

  test("missing tokens reported as has_* false", () => {
    const account = makeAccount({ url: "https://example.com" });
    expect(customAccountConfigAdapter.toAccountConfig(account)).toMatchObject({
      url: "https://example.com",
      has_bot_token: false,
      has_auth: false,
      agent_id: null,
      accounts_json: "",
      configs_json: "",
    });
  });

  test("blank-only tokens reported as has_* false", () => {
    const account = makeAccount({
      url: "https://example.com",
      bot_token: "   ",
      auth: "",
    });
    expect(customAccountConfigAdapter.toAccountConfig(account)).toMatchObject({
      has_bot_token: false,
      has_auth: false,
    });
  });
});

describe("customAccountConfigAdapter.toAccountPatch", () => {
  test("returns empty patch (config bag handled separately)", () => {
    expect(
      customAccountConfigAdapter.toAccountPatch({
        url: "https://example.com",
        bot_token: "secret",
      }),
    ).toEqual({});
  });
});

describe("customAccountConfigAdapter.shouldRefreshDisplayName", () => {
  test("never auto-refreshes display name", () => {
    expect(customAccountConfigAdapter.shouldRefreshDisplayName({})).toBe(false);
  });
});

describe("customAccountConfigAdapter.toConfigSnapshotConfig", () => {
  test("matches toAccountConfig", () => {
    const account = makeAccount({
      url: "https://example.com",
      auth: "x",
    });
    expect(customAccountConfigAdapter.toConfigSnapshotConfig(account)).toEqual(
      customAccountConfigAdapter.toAccountConfig(account),
    );
  });
});
