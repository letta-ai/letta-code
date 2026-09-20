import { describe, expect, mock, test } from "bun:test";
import { ApiRequestError } from "@/backend/api/request";
import type { LocalOAuthConnectCallbacks } from "@/cli/commands/connect-local-oauth";
import {
  mapCloudXaiOAuthCheckError,
  runCloudXaiOAuthConnectFlow,
  serializeXaiOAuthCredential,
} from "@/cli/commands/connect-xai-oauth";
import {
  type ByokProvider,
  getProviderConfigs,
  isXaiOAuthProvider,
} from "@/providers/byok-providers";

const CLOUD_GROK: ByokProvider = {
  id: "grok",
  displayName: "xAI (Grok/X subscription)",
  description: "Connect a subscription account",
  providerType: "xai",
  providerName: "lc-xai",
  isOAuth: true,
  oauthProviderId: "xai",
};

const OAUTH_CREDENTIAL = {
  type: "oauth" as const,
  access: "oauth-access",
  refresh: "oauth-refresh",
  expires: 2_000_000_000_000,
};

describe("Cloud xAI OAuth connect", () => {
  test("Cloud catalog row uses lc-xai and never the reserved xai name", () => {
    const grok = getProviderConfigs("api").find(
      (provider) => provider.id === "grok",
    );
    expect(grok).toMatchObject({
      displayName: "xAI (Grok/X subscription)",
      providerType: "xai",
      providerName: "lc-xai",
      isOAuth: true,
      oauthProviderId: "xai",
    });
    expect(grok?.providerName).not.toBe("xai");
    expect(isXaiOAuthProvider(grok as ByokProvider)).toBe(true);
  });

  test("serializes Pi's JSON bundle and refuses to persist only an access token", () => {
    const serialized = serializeXaiOAuthCredential(OAUTH_CREDENTIAL);
    expect(JSON.parse(serialized)).toEqual({
      type: "oauth",
      access: "oauth-access",
      refresh: "oauth-refresh",
      expires: 2_000_000_000_000,
    });
    expect(serialized).not.toBe("oauth-access");
    expect(() =>
      serializeXaiOAuthCredential({
        type: "oauth",
        access: "oauth-access",
        refresh: "",
        expires: 2_000_000_000_000,
      }),
    ).toThrow("refreshable credential bundle");
    expect(() =>
      serializeXaiOAuthCredential({
        type: "api_key",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: 2_000_000_000_000,
      }),
    ).toThrow("did not return OAuth credentials");
  });

  test("persists JSON credentials through check then create-or-update", async () => {
    const statuses: string[] = [];
    const checkProviderApiKey = mock(() => Promise.resolve());
    const createOrUpdateProvider = mock(() =>
      Promise.resolve({
        id: "provider-1",
        name: "lc-xai",
        provider_type: "xai",
      }),
    );
    const clearCache = mock(() => {});
    const login = mock(async () => ({
      providerName: "lc-xai",
      credential: OAUTH_CREDENTIAL,
      apiKey: "minted-access-token-do-not-store",
    }));

    const result = await runCloudXaiOAuthConnectFlow(
      CLOUD_GROK,
      {
        onStatus: (status) => {
          statuses.push(status);
        },
      } satisfies LocalOAuthConnectCallbacks,
      {
        runLogin: login,
        checkProviderApiKey,
        createOrUpdateProvider,
        clearAvailableModelsCache: clearCache,
      },
    );

    const serialized = serializeXaiOAuthCredential(OAUTH_CREDENTIAL);
    expect(checkProviderApiKey).toHaveBeenCalledWith(
      "xai",
      serialized,
      undefined,
      undefined,
      undefined,
      { target: "api" },
    );
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      "xai",
      "lc-xai",
      serialized,
      undefined,
      undefined,
      undefined,
      {},
      { target: "api" },
    );
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ providerName: "lc-xai" });
    expect(statuses.some((status) => status.includes("Validating"))).toBe(true);
    expect(statuses.some((status) => status.includes("Saving"))).toBe(true);
  });

  test("upserts lc-xai when the provider already exists", async () => {
    const createOrUpdateProvider = mock(() =>
      Promise.resolve({
        id: "existing-lc-xai",
        name: "lc-xai",
        provider_type: "xai",
      }),
    );

    await runCloudXaiOAuthConnectFlow(
      CLOUD_GROK,
      { onStatus: () => {} },
      {
        runLogin: async () => ({
          providerName: "lc-xai",
          credential: OAUTH_CREDENTIAL,
          apiKey: "new-access",
        }),
        checkProviderApiKey: async () => {},
        createOrUpdateProvider,
        clearAvailableModelsCache: () => {},
      },
    );

    expect(createOrUpdateProvider).toHaveBeenCalledTimes(1);
    expect(createOrUpdateProvider).toHaveBeenCalledWith(
      "xai",
      "lc-xai",
      serializeXaiOAuthCredential(OAUTH_CREDENTIAL),
      undefined,
      undefined,
      undefined,
      {},
      { target: "api" },
    );
  });

  test("rejects the reserved hosted provider name", async () => {
    await expect(
      runCloudXaiOAuthConnectFlow(
        { ...CLOUD_GROK, providerName: "xai" },
        { onStatus: () => {} },
        {
          runLogin: async () => {
            throw new Error("login should not run");
          },
        },
      ),
    ).rejects.toThrow("reserved for hosted models");
  });

  test("maps older Cloud APIs that treat JSON as a bearer token", () => {
    const error = mapCloudXaiOAuthCheckError(
      new ApiRequestError(
        'API error (401): {"detail":"Invalid API key"}',
        401,
        '{"detail":"Invalid API key"}',
      ),
    );
    expect(error.message).toContain("bearer token");
    expect(error.message).toContain("xAI OAuth JSON support");
  });

  test("does not rewrite unrelated Cloud check failures as a bearer-token mismatch", () => {
    const error = mapCloudXaiOAuthCheckError(
      new Error("not entitled to Grok subscription inference"),
    );
    expect(error.message).toBe("not entitled to Grok subscription inference");
    expect(error.message).not.toContain("bearer token");
  });
});
