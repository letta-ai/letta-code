import { describe, expect, test } from "bun:test";
import {
  isConnectProviderOAuthConfig,
  isProviderOAuthTokensConfig,
} from "@/types/provider-oauth-config";

const tokens = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 2_000_000_000_000,
};

const chatgptConfig = {
  access_token: "access-token",
  id_token: "id-token",
  refresh_token: "refresh-token",
  account_id: "account-id",
  expires_at: 1_800_000_000_000,
};

describe("provider OAuth tokens config", () => {
  test("accepts a complete pi-ai credential bundle", () => {
    expect(isProviderOAuthTokensConfig(tokens)).toBe(true);
  });

  test("rejects a bundle without a refresh token", () => {
    const { refresh: _refresh, ...withoutRefresh } = tokens;
    expect(isProviderOAuthTokensConfig(withoutRefresh)).toBe(false);
    expect(isProviderOAuthTokensConfig({ ...tokens, refresh: "" })).toBe(false);
    expect(isProviderOAuthTokensConfig({ ...tokens, refresh: "   " })).toBe(
      false,
    );
  });

  test("rejects a bundle without an access token", () => {
    expect(isProviderOAuthTokensConfig({ ...tokens, access: "" })).toBe(false);
    expect(isProviderOAuthTokensConfig({ ...tokens, access: "   " })).toBe(
      false,
    );
    const { access: _access, ...withoutAccess } = tokens;
    expect(isProviderOAuthTokensConfig(withoutAccess)).toBe(false);
  });

  test("rejects a non-numeric or non-finite expiry", () => {
    expect(
      isProviderOAuthTokensConfig({ ...tokens, expires: "2000000000000" }),
    ).toBe(false);
    expect(
      isProviderOAuthTokensConfig({ ...tokens, expires: Number.NaN }),
    ).toBe(false);
    expect(
      isProviderOAuthTokensConfig({
        ...tokens,
        expires: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });

  test("rejects a bundle that is not tagged as OAuth", () => {
    expect(isProviderOAuthTokensConfig({ ...tokens, type: "api" })).toBe(false);
    const { type: _type, ...untagged } = tokens;
    expect(isProviderOAuthTokensConfig(untagged)).toBe(false);
  });

  test("rejects non-objects", () => {
    for (const value of [null, undefined, "oauth", 7, []]) {
      expect(isProviderOAuthTokensConfig(value)).toBe(false);
    }
  });

  test("does not accept a ChatGPT config as a token bundle", () => {
    expect(isProviderOAuthTokensConfig(chatgptConfig)).toBe(false);
  });
});

describe("connect provider OAuth config union", () => {
  test("accepts either supported credential shape", () => {
    expect(isConnectProviderOAuthConfig(tokens)).toBe(true);
    expect(isConnectProviderOAuthConfig(chatgptConfig)).toBe(true);
  });

  test("rejects a partial credential of either shape", () => {
    expect(isConnectProviderOAuthConfig({ access: "access-token" })).toBe(
      false,
    );
    expect(
      isConnectProviderOAuthConfig({ type: "oauth", access: "access-token" }),
    ).toBe(false);
    const { account_id: _accountId, ...withoutAccount } = chatgptConfig;
    expect(isConnectProviderOAuthConfig(withoutAccount)).toBe(false);
  });
});
