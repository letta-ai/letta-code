import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DeviceCodeResponse, TokenResponse } from "../../auth/oauth";
import { settingsManager } from "../../settings-manager";

const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
  throw new Error("refreshAccessToken not mocked");
});
const requestDeviceCodeMock = mock(async (): Promise<DeviceCodeResponse> => {
  throw new Error("requestDeviceCode not mocked");
});
const pollForTokenMock = mock(async (): Promise<TokenResponse> => {
  throw new Error("pollForToken not mocked");
});

const { __listenSubcommandTestUtils } = await import(
  "../../cli/subcommands/listen"
);

describe("listen subcommand auth resolution", () => {
  const originalGetSettingsWithSecureTokens =
    settingsManager.getSettingsWithSecureTokens;
  const originalUpdateSettings = settingsManager.updateSettings;
  const originalFlush = settingsManager.flush;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  beforeEach(() => {
    refreshAccessTokenMock.mockReset();
    requestDeviceCodeMock.mockReset();
    pollForTokenMock.mockReset();
    __listenSubcommandTestUtils.setOAuthDepsForTests({
      LETTA_CLOUD_API_URL: "https://api.letta.com",
      refreshAccessToken: refreshAccessTokenMock,
      requestDeviceCode: requestDeviceCodeMock,
      pollForToken: pollForTokenMock,
    });

    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings = mock(
      () => {},
    ) as typeof settingsManager.updateSettings;
    settingsManager.flush = mock(
      async () => {},
    ) as typeof settingsManager.flush;

    console.log = mock(() => {}) as typeof console.log;
    console.warn = mock(() => {}) as typeof console.warn;
  });

  afterEach(() => {
    settingsManager.getSettingsWithSecureTokens =
      originalGetSettingsWithSecureTokens;
    settingsManager.updateSettings = originalUpdateSettings;
    settingsManager.flush = originalFlush;

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
    __listenSubcommandTestUtils.setOAuthDepsForTests(null);
  });

  test("prefers explicit LETTA_API_KEY over saved OAuth credentials", async () => {
    process.env.LETTA_API_KEY = "env-key";

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        LETTA_API_KEY: "stored-key",
      },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    const result =
      await __listenSubcommandTestUtils.resolveListenerRegistrationOptions(
        "device-1",
        "listener-env",
      );

    expect(result).toMatchObject({
      serverUrl: "https://api.letta.com",
      apiKey: "env-key",
      deviceId: "device-1",
      connectionName: "listener-env",
    });
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(pollForTokenMock).not.toHaveBeenCalled();
  });

  test("refreshes saved Letta Cloud tokens when they are expired", async () => {
    const updateSettingsMock = mock(() => {});
    const flushMock = mock(async () => {});

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        SOME_FLAG: "1",
        LETTA_API_KEY: "stored-key",
      },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings =
      updateSettingsMock as typeof settingsManager.updateSettings;
    settingsManager.flush = flushMock as typeof settingsManager.flush;

    refreshAccessTokenMock.mockImplementation(async () => ({
      access_token: "refreshed-key",
      refresh_token: "new-refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
    }));

    const result =
      await __listenSubcommandTestUtils.resolveListenerRegistrationOptions(
        "device-2",
        "listener-refresh",
      );

    expect(result.apiKey).toBe("refreshed-key");
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      "refresh-token",
      "device-2",
      "listener-refresh",
    );
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          SOME_FLAG: "1",
          LETTA_API_KEY: "refreshed-key",
        },
        refreshToken: "new-refresh-token",
        tokenExpiresAt: expect.any(Number),
      }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
  });

  test("falls back to device flow when refresh fails", async () => {
    const updateSettingsMock = mock(() => {});
    const flushMock = mock(async () => {});

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {
        SOME_FLAG: "1",
        LETTA_API_KEY: "stored-key",
      },
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;
    settingsManager.updateSettings =
      updateSettingsMock as typeof settingsManager.updateSettings;
    settingsManager.flush = flushMock as typeof settingsManager.flush;

    refreshAccessTokenMock.mockRejectedValue(new Error("refresh broke"));
    requestDeviceCodeMock.mockImplementation(async () => ({
      device_code: "device-code",
      user_code: "ABC123",
      verification_uri: "https://app.letta.com/device",
      verification_uri_complete: "https://app.letta.com/device?code=ABC123",
      expires_in: 900,
      interval: 5,
    }));
    pollForTokenMock.mockImplementation(async () => ({
      access_token: "oauth-key",
      refresh_token: "oauth-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    }));

    const result =
      await __listenSubcommandTestUtils.resolveListenerRegistrationOptions(
        "device-3",
        "listener-oauth",
      );

    expect(result.apiKey).toBe("oauth-key");
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(requestDeviceCodeMock).toHaveBeenCalledTimes(1);
    expect(pollForTokenMock).toHaveBeenCalledWith(
      "device-code",
      5,
      900,
      "device-3",
      "listener-oauth",
    );
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          SOME_FLAG: "1",
          LETTA_API_KEY: "oauth-key",
        },
        refreshToken: "oauth-refresh",
        tokenExpiresAt: expect.any(Number),
      }),
    );
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  test("does not start OAuth for self-hosted listeners without an API key", async () => {
    process.env.LETTA_BASE_URL = "https://self-hosted.example.com";

    settingsManager.getSettingsWithSecureTokens = mock(async () => ({
      env: {},
    })) as unknown as typeof settingsManager.getSettingsWithSecureTokens;

    await expect(
      __listenSubcommandTestUtils.resolveListenerRegistrationOptions(
        "device-4",
        "listener-self-hosted",
      ),
    ).rejects.toThrow("LETTA_API_KEY not found");

    expect(requestDeviceCodeMock).not.toHaveBeenCalled();
    expect(pollForTokenMock).not.toHaveBeenCalled();
  });
});
