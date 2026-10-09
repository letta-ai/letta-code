import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type DeviceCodeResponse,
  OAuthRefreshError,
  type TokenResponse,
} from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import {
  __listenerAuthTestUtils,
  ListenerReauthenticationRequiredError,
  resolveListenerReconnectAuth,
  resolveListenerRegistrationOptions,
} from "@/websocket/listener/auth";
import {
  __listenerIdentityTestUtils,
  LISTENER_INSTANCE_ID_ENV,
} from "@/websocket/listener/identity";
import {
  type OrgCredentials,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
  throw new Error("refreshAccessToken not mocked");
});
const requestDeviceCodeMock = mock(async (): Promise<DeviceCodeResponse> => {
  throw new Error("requestDeviceCode not mocked");
});
const pollForTokenMock = mock(async (): Promise<TokenResponse> => {
  throw new Error("pollForToken not mocked");
});
const openInBrowserMock = mock((_url: string) => {});

describe("listener auth", () => {
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;
  const originalListenerInstanceId = process.env[LISTENER_INSTANCE_ID_ENV];

  let settings: ListenerSettings;
  const updateSettingsMock = mock(() => {});
  const flushMock = mock(async () => {});
  const originalOrgLoad = orgCredentialStore.load;
  const originalOrgSave = orgCredentialStore.save;
  let orgCredentials: Record<string, OrgCredentials>;

  beforeEach(() => {
    settings = { env: {} } as ListenerSettings;
    orgCredentials = {};
    orgCredentialStore.load = async (organizationId) =>
      orgCredentials[organizationId] ?? {};
    orgCredentialStore.save = async (organizationId, credentials) => {
      orgCredentials[organizationId] = credentials;
    };
    refreshAccessTokenMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollForTokenMock.mockReset();
    openInBrowserMock.mockReset();
    updateSettingsMock.mockReset();
    flushMock.mockReset();
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
      requestDeviceCode: requestDeviceCodeMock,
      pollForToken: pollForTokenMock,
      openInBrowser: openInBrowserMock,
    });
    settingsManager.getSettingsWithSecureTokens = mock(
      async () => settings,
    ) as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings =
      updateSettingsMock as typeof settingsManager.updateSettings;
    settingsManager.flush = flushMock as typeof settingsManager.flush;

    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    delete process.env[LISTENER_INSTANCE_ID_ENV];
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    orgCredentialStore.load = originalOrgLoad;
    orgCredentialStore.save = originalOrgSave;
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.updateSettings = originalUpdateSettings;
    settingsManager.flush = originalFlush;
    __listenerAuthTestUtils.setOAuthDepsForTests(null);
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;

    if (originalApiKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalApiKey;
    }
    if (originalBaseUrl === undefined) {
      delete process.env.LETTA_BASE_URL;
    } else {
      process.env.LETTA_BASE_URL = originalBaseUrl;
    }
    __listenerIdentityTestUtils.resetCachedSpawnerIdentity();
    if (originalListenerInstanceId === undefined) {
      delete process.env[LISTENER_INSTANCE_ID_ENV];
    } else {
      process.env[LISTENER_INSTANCE_ID_ENV] = originalListenerInstanceId;
    }
  });

  test("refreshes a missing access token and persists refresh rotation", async () => {
    settings = {
      ...settings,
      env: {},
      refreshToken: "refresh-token",
    };
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    expect(
      await resolveListenerReconnectAuth({
        deviceId: "device-id",
        connectionName: "listener-name",
      }),
    ).toEqual({ kind: "ready", apiKey: "new-access-token" });
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: { LETTA_API_KEY: "new-access-token" },
        refreshToken: "rotated-refresh-token",
        tokenExpiresAt: expect.any(Number),
      }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();
  });

  test("keeps a still-valid token when proactive refresh fails transiently", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "still-valid" },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() + 60_000,
    };
    refreshAccessTokenMock.mockRejectedValue(
      new OAuthRefreshError("auth service unavailable", {
        retryable: true,
        status: 503,
      }),
    );

    expect(
      await resolveListenerReconnectAuth({
        deviceId: "device-id",
        connectionName: "listener-name",
      }),
    ).toEqual({ kind: "ready", apiKey: "still-valid" });
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  test("marks transient refresh failure retryable after access expires", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired" },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock.mockRejectedValue(
      new OAuthRefreshError("network unavailable", { retryable: true }),
    );

    expect(
      await resolveListenerReconnectAuth({
        deviceId: "device-id",
        connectionName: "listener-name",
      }),
    ).toEqual({ kind: "retry" });
  });

  test("surfaces revoked refresh credentials without starting device OAuth", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "expired" },
      refreshToken: "revoked-refresh-token",
      tokenExpiresAt: Date.now() - 1,
    };
    refreshAccessTokenMock.mockRejectedValue(
      new OAuthRefreshError("invalid_grant", {
        retryable: false,
        status: 400,
        oauthCode: "invalid_grant",
      }),
    );

    await expect(
      resolveListenerReconnectAuth({
        deviceId: "device-id",
        connectionName: "listener-name",
      }),
    ).rejects.toBeInstanceOf(ListenerReauthenticationRequiredError);
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  test("opens the device-auth page when no credentials exist", async () => {
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.letta.com/oauth/device",
      verification_uri_complete:
        "https://app.letta.com/oauth/device?user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });
    pollForTokenMock.mockResolvedValue({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const result = await resolveListenerRegistrationOptions(
      "device-id",
      "listener-name",
    );

    expect(openInBrowserMock).toHaveBeenCalledWith(
      "https://app.letta.com/oauth/device?user_code=ABCD-EFGH",
    );
    expect(result.apiKey).toBe("new-access-token");
  });

  test("builds fresh in-app registration options from current credentials", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "first-access-token" },
    };
    const first = await resolveListenerRegistrationOptions(
      "device-id",
      "listener-name",
      { allowInteractiveOAuth: false, surface: "listen" },
    );

    settings = {
      ...settings,
      env: { LETTA_API_KEY: "refreshed-access-token" },
    };
    const second = await resolveListenerRegistrationOptions(
      "device-id",
      "listener-name",
      { allowInteractiveOAuth: false, surface: "listen" },
    );

    expect(first.apiKey).toBe("first-access-token");
    expect(second.apiKey).toBe("refreshed-access-token");
    expect(second.listenerInstanceId).toStartWith("listen-");
  });

  test("signs in to the requested organization without touching the global sign-in", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "global-access-token" },
      refreshToken: "global-refresh-token",
    };
    requestDeviceCodeMock.mockResolvedValue({
      device_code: "device-code",
      user_code: "ABCD-EFGH",
      verification_uri: "https://app.letta.com/oauth/device",
      verification_uri_complete:
        "https://app.letta.com/oauth/device?user_code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });
    pollForTokenMock.mockResolvedValue({
      access_token: "org-access-token",
      refresh_token: "org-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const result = await resolveListenerRegistrationOptions(
      "org-device-id",
      "listener-name",
      { organizationId: "org-123" },
    );

    expect(result.apiKey).toBe("org-access-token");
    expect(requestDeviceCodeMock).toHaveBeenCalledWith("org-123");
    expect(pollForTokenMock).toHaveBeenCalledWith(
      "device-code",
      5,
      600,
      "org-device-id",
      "listener-name",
    );
    expect(orgCredentials["org-123"]).toEqual({
      apiKey: "org-access-token",
      refreshToken: "org-refresh-token",
      tokenExpiresAt: expect.any(Number),
    });
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  test("ignores ambient keys when an organization is requested", async () => {
    process.env.LETTA_API_KEY = "env-access-token";
    orgCredentials["org-123"] = { apiKey: "org-access-token" };

    const result = await resolveListenerRegistrationOptions(
      "org-device-id",
      "listener-name",
      { organizationId: "org-123" },
    );

    expect(result.apiKey).toBe("org-access-token");
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  test("refreshes an organization token into its own slot on reconnect", async () => {
    orgCredentials["org-123"] = { refreshToken: "org-refresh-token" };
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "org-access-token",
      refresh_token: "rotated-org-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    });

    expect(
      await resolveListenerReconnectAuth({
        deviceId: "org-device-id",
        connectionName: "listener-name",
        organizationId: "org-123",
      }),
    ).toEqual({ kind: "ready", apiKey: "org-access-token" });
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      "org-refresh-token",
      "org-device-id",
      "listener-name",
    );
    expect(orgCredentials["org-123"]).toEqual({
      apiKey: "org-access-token",
      refreshToken: "rotated-org-refresh-token",
      tokenExpiresAt: expect.any(Number),
    });
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  test("caches a spawner identity across registrations without exposing it to descendants", async () => {
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "spawner-access-token" },
    };
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";

    const firstRegistration = resolveListenerRegistrationOptions(
      "device-id",
      "listener-name",
      { allowInteractiveOAuth: false, surface: "server" },
    );
    // Consumption is synchronous—before authentication reaches its first
    // await—so no concurrent hook/descendant can inherit the transport env.
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
    const first = await firstRegistration;
    expect(first.listenerInstanceId).toBe("desktop-primary:install-42");

    const second = await resolveListenerRegistrationOptions(
      "device-id",
      "different-display-name",
      { allowInteractiveOAuth: false, surface: "server" },
    );
    // Re-registration retains the owner identity from process-local cache;
    // it does not fall back to the new display-name-derived identity.
    expect(second.listenerInstanceId).toBe("desktop-primary:install-42");
    expect(process.env[LISTENER_INSTANCE_ID_ENV]).toBeUndefined();
  });
});
