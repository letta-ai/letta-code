import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenResponse } from "@/auth/oauth";
import type { PersistedAuthTokens } from "@/auth/persisted-tokens";
import { refreshTokensUnderCrossProcessLock } from "@/backend/api/client";

const FRESH_EXPIRY = Date.now() + 60 * 60 * 1000;
const STALE_EXPIRY = Date.now() - 1_000;

function snapshot(
  overrides: Partial<PersistedAuthTokens>,
): PersistedAuthTokens {
  return {
    apiKey: null,
    refreshToken: null,
    tokenExpiresAt: null,
    strict: true,
    ...overrides,
  };
}

function makeLockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "oauth-lock-")), "refresh.lock");
}

const ROTATED: TokenResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
} as TokenResponse;

describe("refreshTokensUnderCrossProcessLock", () => {
  test("waiter reuses the winner's persisted token without refreshing", async () => {
    const lockPath = makeLockPath();
    const refresh = mock(async () => ROTATED);
    const persist = mock(async () => {});
    const result = await refreshTokensUnderCrossProcessLock("fallback", {
      readTokens: async () =>
        snapshot({
          apiKey: "winner-access",
          refreshToken: "winner-refresh",
          tokenExpiresAt: FRESH_EXPIRY,
        }),
      refresh,
      persist,
      lockPath,
    });
    expect(result).toBe("winner-access");
    expect(refresh).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("refreshes with the persisted refresh token, not the caller's stale copy", async () => {
    const lockPath = makeLockPath();
    const reads = [
      snapshot({
        apiKey: "old-access",
        refreshToken: "disk-refresh",
        tokenExpiresAt: STALE_EXPIRY,
      }),
      snapshot({ apiKey: "new-access", refreshToken: "new-refresh" }),
    ];
    const refresh = mock(async (refreshToken: string) => {
      expect(refreshToken).toBe("disk-refresh");
      return ROTATED;
    });
    const persisted: unknown[] = [];
    const result = await refreshTokensUnderCrossProcessLock(
      "stale-in-memory-refresh",
      {
        readTokens: async () => reads.shift() ?? snapshot({}),
        refresh,
        persist: async (updates) => {
          persisted.push(updates);
        },
        lockPath,
      },
    );
    expect(result).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([
      {
        env: { LETTA_API_KEY: "new-access" },
        refreshToken: "new-refresh",
        tokenExpiresAt: expect.any(Number),
      },
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("throws when the strict read-back is missing the rotated refresh token", async () => {
    const lockPath = makeLockPath();
    const reads = [
      snapshot({ refreshToken: "disk-refresh", tokenExpiresAt: STALE_EXPIRY }),
      // Partial persistence: new access token stored, refresh token still old.
      snapshot({ apiKey: "new-access", refreshToken: "disk-refresh" }),
    ];
    await expect(
      refreshTokensUnderCrossProcessLock("fallback", {
        readTokens: async () => reads.shift() ?? snapshot({}),
        refresh: async () => ROTATED,
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow(/failed to persist/);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("accepts a non-strict read-back (no keychain to verify against)", async () => {
    const lockPath = makeLockPath();
    const reads = [
      snapshot({ refreshToken: "disk-refresh", tokenExpiresAt: STALE_EXPIRY }),
      snapshot({ apiKey: null, refreshToken: null, strict: false }),
    ];
    const result = await refreshTokensUnderCrossProcessLock("fallback", {
      readTokens: async () => reads.shift() ?? snapshot({}),
      refresh: async () => ROTATED,
      persist: async () => {},
      lockPath,
    });
    expect(result).toBe("new-access");
  });

  test("releases the lock when the refresh itself fails", async () => {
    const lockPath = makeLockPath();
    await expect(
      refreshTokensUnderCrossProcessLock("fallback", {
        readTokens: async () => snapshot({ tokenExpiresAt: STALE_EXPIRY }),
        refresh: async () => {
          throw new Error("network down");
        },
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow("network down");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("serializes two same-process contenders: loser reuses the winner's result", async () => {
    const lockPath = makeLockPath();
    // Shared "persisted store": the winner's persist() updates it, so the
    // loser's under-lock read sees fresh tokens and skips its own refresh.
    let store = snapshot({
      refreshToken: "disk-refresh",
      tokenExpiresAt: STALE_EXPIRY,
    });
    const refresh = mock(async () => ROTATED);
    const deps = {
      readTokens: async () => store,
      refresh,
      persist: async () => {
        store = snapshot({
          apiKey: "new-access",
          refreshToken: "new-refresh",
          tokenExpiresAt: FRESH_EXPIRY,
        });
      },
      lockPath,
    };
    const [first, second] = await Promise.all([
      refreshTokensUnderCrossProcessLock("fallback", deps),
      refreshTokensUnderCrossProcessLock("fallback", deps),
    ]);
    expect(first).toBe("new-access");
    expect(second).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(existsSync(lockPath)).toBe(false);
  });
});
