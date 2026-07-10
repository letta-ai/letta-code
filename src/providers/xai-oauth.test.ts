import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { getLocalProviderRecordByName } from "@/backend/local/local-provider-auth-store";
import { runLocalOAuthConnectFlow } from "@/cli/commands/connect-local-oauth";
import {
  assertTrustedXaiOAuthUrl,
  ensureXaiOAuthProviderRegistered,
  loginXaiOAuth,
  pollXaiDeviceToken,
  refreshXaiOAuthToken,
  requestXaiDeviceCode,
  XAI_OAUTH_CONFIG,
  XAI_OAUTH_PROVIDER_ID,
  XaiOAuthError,
  xaiOAuthProvider,
} from "@/providers/xai-oauth";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("xai-oauth", () => {
  test("registers into pi-ai OAuth provider registry", () => {
    ensureXaiOAuthProviderRegistered();
    const provider = getOAuthProvider(XAI_OAUTH_PROVIDER_ID);
    expect(provider?.id).toBe("xai");
    expect(provider?.name).toBe(xaiOAuthProvider.name);
  });

  test("assertTrustedXaiOAuthUrl accepts x.ai hosts over HTTPS", () => {
    expect(
      assertTrustedXaiOAuthUrl("https://auth.x.ai/oauth2/token", "t"),
    ).toBe("https://auth.x.ai/oauth2/token");
    expect(assertTrustedXaiOAuthUrl("https://x.ai/v1/", "t")).toBe(
      "https://x.ai/v1",
    );
  });

  test("assertTrustedXaiOAuthUrl rejects off-origin and non-HTTPS hosts", () => {
    expect(() =>
      assertTrustedXaiOAuthUrl("http://auth.x.ai/token", "t"),
    ).toThrow(XaiOAuthError);
    expect(() =>
      assertTrustedXaiOAuthUrl("https://evil.example/token", "t"),
    ).toThrow(XaiOAuthError);
    expect(() =>
      assertTrustedXaiOAuthUrl("https://auth.x.ai.evil.com/token", "t"),
    ).toThrow(XaiOAuthError);
  });

  test("requestXaiDeviceCode posts client_id and scope", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? "") });
      return jsonResponse(200, {
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete:
          "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        expires_in: 1800,
        interval: 5,
      });
    }) as unknown as typeof fetch;

    const device = await requestXaiDeviceCode(fetchImpl);
    expect(device.user_code).toBe("ABCD-EFGH");
    expect(device.device_code).toBe("device-code");
    expect(calls[0]?.url).toBe(XAI_OAUTH_CONFIG.deviceCodeUrl);
    expect(calls[0]?.body).toContain(`client_id=${XAI_OAUTH_CONFIG.clientId}`);
    expect(calls[0]?.body).toContain("scope=");
  });

  test("pollXaiDeviceToken waits through authorization_pending", async () => {
    let pollCount = 0;
    const fetchImpl = mock(async () => {
      pollCount += 1;
      if (pollCount === 1) {
        return jsonResponse(400, {
          error: "authorization_pending",
          error_description: "waiting",
        });
      }
      return jsonResponse(200, {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as unknown as typeof fetch;

    const credentials = await pollXaiDeviceToken({
      deviceCode: "device-code",
      tokenEndpoint: XAI_OAUTH_CONFIG.defaultTokenUrl,
      expiresIn: 30,
      interval: 0,
      fetchImpl,
    });

    expect(credentials.access).toBe("access-1");
    expect(credentials.refresh).toBe("refresh-1");
    expect(credentials.tokenEndpoint).toBe(XAI_OAUTH_CONFIG.defaultTokenUrl);
    expect(pollCount).toBe(2);
  });

  test("refreshXaiOAuthToken rotates tokens and preserves refresh when omitted", async () => {
    const rotating = mock(async () =>
      jsonResponse(200, {
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 7200,
      }),
    ) as unknown as typeof fetch;

    const rotated = await refreshXaiOAuthToken(
      {
        access: "access-1",
        refresh: "refresh-1",
        expires: Date.now() - 1000,
        tokenEndpoint: XAI_OAUTH_CONFIG.defaultTokenUrl,
      },
      rotating,
    );
    expect(rotated.access).toBe("access-2");
    expect(rotated.refresh).toBe("refresh-2");

    const stable = mock(async () =>
      jsonResponse(200, {
        access_token: "access-3",
        expires_in: 3600,
      }),
    ) as unknown as typeof fetch;

    const preserved = await refreshXaiOAuthToken(
      {
        access: "access-2",
        refresh: "refresh-stable",
        expires: Date.now() - 1000,
      },
      stable,
    );
    expect(preserved.access).toBe("access-3");
    expect(preserved.refresh).toBe("refresh-stable");
  });

  test("refreshXaiOAuthToken maps 403 to tier denial without relogin", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(403, { error: "permission_denied" }),
    ) as unknown as typeof fetch;

    try {
      await refreshXaiOAuthToken(
        {
          access: "a",
          refresh: "r",
          expires: 0,
        },
        fetchImpl,
      );
      expect.unreachable("expected refresh to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(XaiOAuthError);
      const oauthError = error as XaiOAuthError;
      expect(oauthError.code).toBe("xai_oauth_tier_denied");
      expect(oauthError.reloginRequired).toBe(false);
      expect(oauthError.message).toContain("XAI_API_KEY");
    }
  });

  test("refreshXaiOAuthToken maps 400 invalid_grant to relogin", async () => {
    const fetchImpl = mock(async () =>
      jsonResponse(400, { error: "invalid_grant" }),
    ) as unknown as typeof fetch;

    try {
      await refreshXaiOAuthToken(
        { access: "a", refresh: "r", expires: 0 },
        fetchImpl,
      );
      expect.unreachable("expected refresh to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(XaiOAuthError);
      const oauthError = error as XaiOAuthError;
      expect(oauthError.code).toBe("xai_refresh_failed");
      expect(oauthError.reloginRequired).toBe(true);
    }
  });

  test("loginXaiOAuth drives device code callbacks end-to-end", async () => {
    const fetchImpl = mock(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return jsonResponse(200, {
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        });
      }
      if (url.includes("/device/code")) {
        return jsonResponse(200, {
          device_code: "dc",
          user_code: "CODE-1",
          verification_uri: "https://accounts.x.ai/device",
          expires_in: 60,
          interval: 0,
        });
      }
      return jsonResponse(200, {
        access_token: "login-access",
        refresh_token: "login-refresh",
        expires_in: 3600,
      });
    }) as unknown as typeof fetch;

    const deviceCodes: Array<{ userCode: string; verificationUri: string }> =
      [];
    const authUrls: string[] = [];

    const credentials = await loginXaiOAuth(
      {
        onAuth: (info) => {
          authUrls.push(info.url);
        },
        onDeviceCode: (info) => {
          deviceCodes.push({
            userCode: info.userCode,
            verificationUri: info.verificationUri,
          });
        },
        onPrompt: async () => "",
        onSelect: async () => undefined,
      },
      fetchImpl,
    );

    expect(credentials.access).toBe("login-access");
    expect(credentials.refresh).toBe("login-refresh");
    expect(deviceCodes).toEqual([
      {
        userCode: "CODE-1",
        verificationUri: "https://accounts.x.ai/device",
      },
    ]);
    expect(authUrls).toEqual([]);
  });

  test("runLocalOAuthConnectFlow opens the xAI device authorization URL once", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "xai-local-oauth-flow-"));
    const originalFetch = globalThis.fetch;
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    try {
      const fetchImpl = mock(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
          return jsonResponse(200, {
            authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          });
        }
        if (url.includes("/device/code")) {
          return jsonResponse(200, {
            device_code: "dc",
            user_code: "CODE-1",
            verification_uri: "https://accounts.x.ai/device",
            verification_uri_complete:
              "https://accounts.x.ai/device?user_code=CODE-1",
            expires_in: 60,
            interval: 0,
          });
        }
        return jsonResponse(200, {
          access_token: "login-access",
          refresh_token: "login-refresh",
          expires_in: 3600,
        });
      }) as unknown as typeof fetch;
      globalThis.fetch = fetchImpl;
      process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

      const opened: string[] = [];
      const statuses: string[] = [];
      const result = await runLocalOAuthConnectFlow(
        {
          id: "xai-oauth",
          displayName: "xAI Grok OAuth (SuperGrok)",
          description: "Connect a subscription account",
          providerType: "xai",
          providerName: "xai",
          isOAuth: true,
          oauthProviderId: "xai",
        },
        {
          onStatus: (message) => {
            statuses.push(message);
          },
          openBrowser: async (url) => {
            opened.push(url);
          },
        },
      );

      expect(result.providerName).toBe("xai");
      expect(opened).toEqual(["https://accounts.x.ai/device?user_code=CODE-1"]);
      expect(statuses.join("\n")).toContain("Enter code: CODE-1");
      const record = getLocalProviderRecordByName("xai", storageDir);
      expect(record?.auth.type).toBe("oauth");
      expect(record?.provider_type).toBe("xai");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalStorageDir === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      } else {
        process.env.LETTA_LOCAL_BACKEND_DIR = originalStorageDir;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("getApiKey returns access token", () => {
    expect(
      xaiOAuthProvider.getApiKey({
        access: "tok",
        refresh: "r",
        expires: Date.now() + 60_000,
      }),
    ).toBe("tok");
  });
});
