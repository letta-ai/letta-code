import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TokenResponse } from "@/auth/oauth";
import {
  type OrgCredentials,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

const refreshAccessTokenMock = mock(async (): Promise<TokenResponse> => {
  throw new Error("refreshAccessToken not mocked");
});

mock.module("@/auth/oauth", () => ({
  refreshAccessToken: refreshAccessTokenMock,
}));

const {
  __orgCredentialsTestUtils,
  activateOrgCredentials,
  bindOrgCredentials,
  getOrgAccessToken,
  peekOrgAccessToken,
} = await import("./org-credentials-session");

describe("org credential session", () => {
  const originalLoad = orgCredentialStore.load;
  const originalSave = orgCredentialStore.save;
  let saved: Record<string, OrgCredentials>;

  beforeEach(() => {
    saved = {};
    orgCredentialStore.load = async (organizationId) =>
      saved[organizationId] ?? {};
    orgCredentialStore.save = async (organizationId, credentials) => {
      saved[organizationId] = credentials;
    };
    refreshAccessTokenMock.mockReset();
  });

  afterEach(() => {
    orgCredentialStore.load = originalLoad;
    orgCredentialStore.save = originalSave;
    __orgCredentialsTestUtils.reset();
  });

  test("is absent in an ordinary process", () => {
    expect(getOrgAccessToken()).toBeUndefined();
    expect(peekOrgAccessToken()).toBeUndefined();
    const client = { apiKey: "global" };
    expect(bindOrgCredentials(client).apiKey).toBe("global");
  });

  test("serves the activated token without refreshing while it is fresh", async () => {
    activateOrgCredentials("org-123", "org-device", {
      apiKey: "org-access-token",
      refreshToken: "org-refresh-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });

    expect(await getOrgAccessToken()).toBe("org-access-token");
    expect(peekOrgAccessToken()).toBe("org-access-token");
    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(saved).toEqual({});
  });

  test("refreshes ahead of expiry into the organization slot, never the global sign-in", async () => {
    activateOrgCredentials("org-123", "org-device", {
      apiKey: "stale-org-token",
      refreshToken: "org-refresh-token",
      tokenExpiresAt: Date.now() + 60 * 1000,
    });
    refreshAccessTokenMock.mockResolvedValue({
      access_token: "fresh-org-token",
      refresh_token: "rotated-org-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    });

    const [first, second] = await Promise.all([
      getOrgAccessToken(),
      getOrgAccessToken(),
    ]);

    expect(first).toBe("fresh-org-token");
    expect(second).toBe("fresh-org-token");
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenMock).toHaveBeenCalledWith(
      "org-refresh-token",
      "org-device",
      expect.any(String),
    );
    expect(saved["org-123"]).toEqual({
      apiKey: "fresh-org-token",
      refreshToken: "rotated-org-refresh",
      tokenExpiresAt: expect.any(Number),
    });
    expect(peekOrgAccessToken()).toBe("fresh-org-token");
  });

  test("keeps a still-valid token when refresh fails", async () => {
    activateOrgCredentials("org-123", "org-device", {
      apiKey: "still-valid-token",
      refreshToken: "org-refresh-token",
      tokenExpiresAt: Date.now() + 60 * 1000,
    });
    refreshAccessTokenMock.mockRejectedValue(new Error("network"));

    expect(await getOrgAccessToken()).toBe("still-valid-token");
  });

  test("surfaces refresh failure once the token has expired", async () => {
    activateOrgCredentials("org-123", "org-device", {
      apiKey: "expired-token",
      refreshToken: "org-refresh-token",
      tokenExpiresAt: Date.now() - 1000,
    });
    refreshAccessTokenMock.mockRejectedValue(new Error("revoked"));

    await expect(getOrgAccessToken()).rejects.toThrow("revoked");
  });

  test("re-activation for the same organization updates the token in place", async () => {
    activateOrgCredentials("org-123", "org-device", {
      apiKey: "first-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });
    const client = bindOrgCredentials({ apiKey: "ignored" });
    expect(client.apiKey).toBe("first-token");

    activateOrgCredentials("org-123", "org-device", {
      apiKey: "second-token",
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    });

    // A retained SDK client reads the live token on its next request.
    expect(client.apiKey).toBe("second-token");
    expect(await getOrgAccessToken()).toBe("second-token");
  });
});
