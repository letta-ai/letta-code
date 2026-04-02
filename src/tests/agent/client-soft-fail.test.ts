import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type MockSettings = {
  env: Record<string, string>;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
};

const mockGetSettingsWithSecureTokens = mock(
  async (): Promise<MockSettings> => ({
    env: {},
    refreshToken: null,
    tokenExpiresAt: null,
  }),
);
const mockGetSettings = mock(() => ({ env: {} }));
const mockGetOrCreateDeviceId = mock(() => "device-test");
const mockUpdateSettings = mock(() => {});
const mockRefreshAccessToken = mock(async () => ({
  access_token: "refreshed-token",
  refresh_token: "refresh-token",
  expires_in: 3600,
}));
const mockTrackBoundaryError = mock(() => {});

mock.module("../../settings-manager", () => ({
  settingsManager: {
    getSettingsWithSecureTokens: mockGetSettingsWithSecureTokens,
    getSettings: mockGetSettings,
    getOrCreateDeviceId: mockGetOrCreateDeviceId,
    updateSettings: mockUpdateSettings,
  },
}));

mock.module("../../auth/oauth", () => ({
  LETTA_CLOUD_API_URL: "https://cloud.example",
  refreshAccessToken: mockRefreshAccessToken,
}));

mock.module("../../telemetry/errorReporting", () => ({
  trackBoundaryError: mockTrackBoundaryError,
}));

describe("getClient soft failures", () => {
  const originalConsoleError = console.error;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalBaseUrl = process.env.LETTA_BASE_URL;

  beforeEach(() => {
    mockGetSettingsWithSecureTokens.mockClear();
    mockGetSettings.mockClear();
    mockGetOrCreateDeviceId.mockClear();
    mockUpdateSettings.mockClear();
    mockRefreshAccessToken.mockClear();
    mockTrackBoundaryError.mockClear();

    mockGetSettingsWithSecureTokens.mockResolvedValue({
      env: {},
      refreshToken: null,
      tokenExpiresAt: null,
    });
    mockGetSettings.mockReturnValue({ env: {} });
    mockRefreshAccessToken.mockResolvedValue({
      access_token: "refreshed-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    });

    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_BASE_URL;
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.error = originalConsoleError;

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

  test("throws when credentials are missing instead of exiting the process", async () => {
    const { getClient } = await import("../../agent/client");

    await expect(getClient()).rejects.toThrow("Missing LETTA_API_KEY");
  });

  test("throws when token refresh fails instead of exiting the process", async () => {
    mockGetSettingsWithSecureTokens.mockResolvedValue({
      env: {},
      refreshToken: "refresh-token",
      tokenExpiresAt: Date.now() - 1_000,
    });
    mockRefreshAccessToken.mockRejectedValue(new Error("refresh broke"));

    const { getClient } = await import("../../agent/client");

    await expect(getClient()).rejects.toThrow(
      "Failed to refresh access token: refresh broke",
    );
    expect(mockTrackBoundaryError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: "auth_token_refresh_failed",
        context: "auth_client_token_refresh",
      }),
    );
  });
});
