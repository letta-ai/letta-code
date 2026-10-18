import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  createOrUpdateLocalProvider,
  getLocalOAuthApiKey,
  getLocalProviderRecordByName,
  setLocalOAuthProvider,
} from "./local-provider-auth-store";

describe("local OAuth provider storage", () => {
  const storageDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      storageDirs
        .splice(0)
        .map((storageDir) => rm(storageDir, { recursive: true, force: true })),
    );
  });

  test("persists keyed and keyless OpenAI-compatible connections with their base URL", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-openai-compatible-routing-"),
    );
    storageDirs.push(storageDir);

    await expect(
      createOrUpdateLocalProvider({
        storageDir,
        providerType: "openai-compatible",
        providerName: "openai-compatible",
        apiKey: "not-needed",
      }),
    ).rejects.toThrow("requires a base URL");

    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openai-compatible",
      providerName: "openai-compatible",
      apiKey: "not-needed",
      baseURL: "http://localhost:8000/v1",
    });
    expect(
      getLocalProviderRecordByName("openai-compatible", storageDir),
    ).toMatchObject({
      provider_type: "openai-compatible",
      base_url: "http://localhost:8000/v1",
      auth: { type: "api", key: "not-needed" },
    });

    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openai-compatible",
      providerName: "openai-compatible",
      apiKey: "secret-key",
    });
    expect(
      getLocalProviderRecordByName("openai-compatible", storageDir),
    ).toMatchObject({
      base_url: "http://localhost:8000/v1",
      auth: { type: "api", key: "secret-key" },
    });
  });

  test("preserves proxy routing when OAuth credentials refresh", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-oauth-routing-"));
    storageDirs.push(storageDir);
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "chatgpt_oauth",
      providerName: "chatgpt-work",
      apiKey: JSON.stringify({
        access_token: "old-access-token",
        id_token: "old-id-token",
        account_id: "account-123",
        expires_at: Date.now() + 3_600_000,
      }),
      baseURL: "https://proxy.example.test/backend-api",
      timeout: 30_000,
    });

    setLocalOAuthProvider({
      storageDir,
      providerName: "chatgpt-work",
      providerType: "chatgpt_oauth",
      auth: {
        type: "oauth",
        access: "refreshed-access-token",
        expires: Date.now() + 120_000,
      },
    });

    expect(
      getLocalProviderRecordByName("chatgpt-work", storageDir),
    ).toMatchObject({
      base_url: "https://proxy.example.test/backend-api",
      timeout: 30_000,
      auth: {
        type: "oauth",
        access: "refreshed-access-token",
      },
    });
  });

  test("getLocalOAuthApiKey refreshes a rotating token once across callers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-oauth-refresh-"));
    storageDirs.push(storageDir);
    // A rotating-refresh-token provider: each refresh token works once.
    const usedRefreshTokens = new Set<string>();
    let refreshCalls = 0;
    registerPiProvider("rotating-oauth", {
      api: "openai-completions",
      baseUrl: "https://rotating.example.test",
      models: [],
      oauth: {
        login: async () => {
          throw new Error("not used");
        },
        refreshToken: async (credentials) => {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          if (usedRefreshTokens.has(credentials.refresh)) {
            throw new Error("invalid_grant");
          }
          usedRefreshTokens.add(credentials.refresh);
          return {
            access: "fresh-access",
            refresh: "refresh-2",
            expires: Date.now() + 3_600_000,
          };
        },
        getApiKey: (credentials) => credentials.access,
      },
    });
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: "rotating-oauth",
        providerType: "rotating-oauth",
        auth: {
          type: "oauth",
          access: "expired-access",
          refresh: "refresh-1",
          expires: Date.now() - 1,
        },
      });
      const getKey = () =>
        getLocalOAuthApiKey({
          providerId: "rotating-oauth",
          providerNames: ["rotating-oauth"],
          storageDir,
        });

      const results = await Promise.all([getKey(), getKey()]);

      expect(refreshCalls).toBe(1);
      for (const result of results) {
        expect(result?.apiKey).toBe("fresh-access");
      }
      expect(
        getLocalProviderRecordByName("rotating-oauth", storageDir)?.auth,
      ).toMatchObject({ access: "fresh-access", refresh: "refresh-2" });
    } finally {
      clearRegisteredPiProviders();
    }
  });
});
