import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalProviderRecordByName } from "@/backend/local/local-provider-auth-store";
import { LOCAL_BACKEND_DIR_ENV } from "@/backend/local/paths";
import { connectProvider } from "@/providers/connect-provider-service";

const XAI_LOCAL_PROVIDER_ID = "xai";

const tokens = {
  type: "oauth" as const,
  access: "xai-access-token",
  refresh: "xai-refresh-token",
  expires: 2_000_000_000_000,
};

describe("connect_provider with subscription OAuth tokens", () => {
  let storageDir: string;
  let previousStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "lc-connect-oauth-"));
    previousStorageDir = process.env[LOCAL_BACKEND_DIR_ENV];
    process.env[LOCAL_BACKEND_DIR_ENV] = storageDir;
  });

  afterEach(() => {
    if (previousStorageDir === undefined) {
      delete process.env[LOCAL_BACKEND_DIR_ENV];
    } else {
      process.env[LOCAL_BACKEND_DIR_ENV] = previousStorageDir;
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  test("writes a refreshable local OAuth record for xAI", async () => {
    const result = await connectProvider({
      target: "local",
      providerId: XAI_LOCAL_PROVIDER_ID,
      fields: {},
      oauthConfig: tokens,
    });

    const record = getLocalProviderRecordByName("xai", storageDir);
    expect(record?.provider_type).toBe("xai");
    expect(record?.auth).toEqual({
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expires: tokens.expires,
    });

    const entry = result.providers.find(
      (provider) => provider.id === XAI_LOCAL_PROVIDER_ID,
    );
    expect(entry?.connected).toMatchObject({
      is_connected: true,
      provider_name: "xai",
      provider_type: "xai",
      auth_type: "oauth",
    });
  });

  test("preserves provider-specific OAuth credential fields", async () => {
    await connectProvider({
      target: "local",
      providerId: XAI_LOCAL_PROVIDER_ID,
      fields: {},
      oauthConfig: {
        ...tokens,
        enterpriseUrl: "https://github.example.com",
      },
    });

    const record = getLocalProviderRecordByName("xai", storageDir);
    expect(record?.auth).toMatchObject({
      enterpriseUrl: "https://github.example.com",
    });
  });

  test("keeps the tokens out of the connect response", async () => {
    const result = await connectProvider({
      target: "local",
      providerId: XAI_LOCAL_PROVIDER_ID,
      fields: {},
      oauthConfig: tokens,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(tokens.access);
    expect(serialized).not.toContain(tokens.refresh);
  });

  test("replaces the tokens when the same provider reconnects", async () => {
    await connectProvider({
      target: "local",
      providerId: XAI_LOCAL_PROVIDER_ID,
      fields: {},
      oauthConfig: tokens,
    });
    const created = getLocalProviderRecordByName("xai", storageDir);

    await connectProvider({
      target: "local",
      providerId: XAI_LOCAL_PROVIDER_ID,
      fields: {},
      oauthConfig: {
        ...tokens,
        access: "rotated-access",
        refresh: "rotated-refresh",
      },
    });
    const reconnected = getLocalProviderRecordByName("xai", storageDir);

    expect(reconnected?.id).toBe(created?.id ?? "");
    expect(reconnected?.created_at).toBe(created?.created_at ?? "");
    expect(reconnected?.auth).toMatchObject({
      access: "rotated-access",
      refresh: "rotated-refresh",
    });
  });

  test("rejects tokens sent alongside API credential fields", async () => {
    await expect(
      connectProvider({
        target: "local",
        providerId: XAI_LOCAL_PROVIDER_ID,
        fields: { apiKey: "xai-api-key" },
        oauthConfig: tokens,
      }),
    ).rejects.toThrow("does not accept API credential fields");

    expect(getLocalProviderRecordByName("xai", storageDir)).toBeNull();
  });

  test("rejects tokens for a provider that has no OAuth login", async () => {
    await expect(
      connectProvider({
        target: "local",
        providerId: "groq",
        fields: {},
        oauthConfig: tokens,
      }),
    ).rejects.toThrow("does not accept subscription OAuth tokens");
  });
});
