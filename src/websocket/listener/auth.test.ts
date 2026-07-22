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

describe("listener auth", () => {
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  let settings: ListenerSettings;
  const updateSettingsMock = mock(() => {});
  const flushMock = mock(async () => {});

  beforeEach(() => {
    settings = { env: {} } as ListenerSettings;
    refreshAccessTokenMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollForTokenMock.mockReset();
    updateSettingsMock.mockReset();
    flushMock.mockReset();
    __listenerAuthTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
      requestDeviceCode: requestDeviceCodeMock,
      pollForToken: pollForTokenMock,
    });
    settingsManager.getSettingsWithSecureTokens = mock(
      async () => settings,
    ) as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings =
      updateSettingsMock as typeof settingsManager.updateSettings;
    settingsManager.flush = flushMock as typeof settingsManager.flush;

    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
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

  test("passes a spawner-assigned identity through to registration verbatim", async () => {
    // LET-10085: an owning spawner (Desktop) assigns its child an explicit
    // identity so it never collides with a manual listener sharing the
    // same display name. Manual listeners (no env) keep the legacy
    // name-derived identity — asserted by the test above.
    settings = {
      ...settings,
      env: { LETTA_API_KEY: "spawner-access-token" },
    };
    const previous = process.env.LETTA_LISTENER_INSTANCE_ID;
    process.env.LETTA_LISTENER_INSTANCE_ID = "desktop-primary:install-42";
    try {
      const options = await resolveListenerRegistrationOptions(
        "device-id",
        "listener-name",
        { allowInteractiveOAuth: false, surface: "server" },
      );
      expect(options.listenerInstanceId).toBe("desktop-primary:install-42");
    } finally {
      if (previous === undefined) {
        delete process.env.LETTA_LISTENER_INSTANCE_ID;
      } else {
        process.env.LETTA_LISTENER_INSTANCE_ID = previous;
      }
    }
  });
});
