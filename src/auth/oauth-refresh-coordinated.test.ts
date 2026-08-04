import { describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenResponse } from "@/auth/oauth";
import { refreshTokensCoordinated } from "@/auth/oauth-refresh";
import {
  KeychainReadError,
  type PersistedAuthTokens,
} from "@/auth/persisted-tokens";

const FRESH_EXPIRY = Date.now() + 60 * 60 * 1000;
const STALE_EXPIRY = Date.now() - 1_000;

function snapshot(
  overrides: Partial<PersistedAuthTokens>,
): PersistedAuthTokens {
  return {
    apiKey: null,
    refreshToken: null,
    tokenExpiresAt: null,
    source: "keychain",
    ...overrides,
  };
}

function makeLockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "oauth-lock-")), "oauth-refresh");
}

// proper-lockfile locks `<path>.lock`; assert on that.
function lockHeld(lockPath: string): boolean {
  return existsSync(`${lockPath}.lock`);
}

const ROTATED: TokenResponse = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
} as TokenResponse;

describe("refreshTokensCoordinated", () => {
  test("waiter reuses the winner's persisted token via fresh expiry", async () => {
    const lockPath = makeLockPath();
    const refresh = mock(async () => ROTATED);
    const persist = mock(async () => {});
    const result = await refreshTokensCoordinated("fallback", {
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
    expect(lockHeld(lockPath)).toBe(false);
  });

  test("waiter reuses the winner via refresh-token rotation even with stale expiry", async () => {
    // The persisted refresh token differs from ours: a peer rotated, ours is
    // spent, and using it would revoke theirs — adopt the peer's access token.
    const lockPath = makeLockPath();
    const refresh = mock(async () => ROTATED);
    const result = await refreshTokensCoordinated("our-spent-refresh", {
      readTokens: async () =>
        snapshot({
          apiKey: "winner-access",
          refreshToken: "winner-refresh",
          tokenExpiresAt: null,
        }),
      refresh,
      persist: async () => {},
      lockPath,
    });
    expect(result).toBe("winner-access");
    expect(refresh).not.toHaveBeenCalled();
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
    const result = await refreshTokensCoordinated("disk-refresh", {
      readTokens: async () => reads.shift() ?? snapshot({}),
      refresh,
      persist: async (updates) => {
        persisted.push(updates);
      },
      lockPath,
    });
    expect(result).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(persisted).toEqual([
      {
        env: { LETTA_API_KEY: "new-access" },
        refreshToken: "new-refresh",
        tokenExpiresAt: expect.any(Number),
      },
    ]);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test("throws when the read-back is missing the rotated refresh token", async () => {
    const lockPath = makeLockPath();
    const reads = [
      snapshot({ refreshToken: "disk-refresh", tokenExpiresAt: STALE_EXPIRY }),
      // Partial persistence: new access token stored, refresh token still old.
      snapshot({ apiKey: "new-access", refreshToken: "disk-refresh" }),
    ];
    await expect(
      refreshTokensCoordinated("disk-refresh", {
        readTokens: async () => reads.shift() ?? snapshot({}),
        refresh: async () => ROTATED,
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow(/failed to persist/);
    expect(lockHeld(lockPath)).toBe(false);
  });

  test("verifies the file fallback when the keychain is genuinely unavailable", async () => {
    // source: "file" is authoritative durable storage and MUST be verified —
    // only runtime-scope read-backs are unverifiable.
    const lockPath = makeLockPath();
    const reads = [
      snapshot({
        refreshToken: "disk-refresh",
        tokenExpiresAt: STALE_EXPIRY,
        source: "file",
      }),
      snapshot({ apiKey: "new-access", refreshToken: "stale", source: "file" }),
    ];
    await expect(
      refreshTokensCoordinated("disk-refresh", {
        readTokens: async () => reads.shift() ?? snapshot({}),
        refresh: async () => ROTATED,
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow(/failed to persist/);
  });

  test("accepts a runtime-scope read-back (keychain reads skipped)", async () => {
    const lockPath = makeLockPath();
    const reads = [
      snapshot({ refreshToken: "disk-refresh", tokenExpiresAt: STALE_EXPIRY }),
      snapshot({ apiKey: null, refreshToken: null, source: "runtime-scope" }),
    ];
    const result = await refreshTokensCoordinated("disk-refresh", {
      readTokens: async () => reads.shift() ?? snapshot({}),
      refresh: async () => ROTATED,
      persist: async () => {},
      lockPath,
    });
    expect(result).toBe("new-access");
  });

  test("fails closed on a keychain read error instead of rotating blind", async () => {
    const lockPath = makeLockPath();
    const refresh = mock(async () => ROTATED);
    await expect(
      refreshTokensCoordinated("fallback", {
        readTokens: async () => {
          throw new KeychainReadError("keychain read timed out (5000ms)");
        },
        refresh,
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow(KeychainReadError);
    expect(refresh).not.toHaveBeenCalled();
    expect(lockHeld(lockPath)).toBe(false);
  });

  test("releases the lock when the refresh itself fails", async () => {
    const lockPath = makeLockPath();
    await expect(
      refreshTokensCoordinated("fallback", {
        readTokens: async () => snapshot({ tokenExpiresAt: STALE_EXPIRY }),
        refresh: async () => {
          throw new Error("network down");
        },
        persist: async () => {},
        lockPath,
      }),
    ).rejects.toThrow("network down");
    expect(lockHeld(lockPath)).toBe(false);
  });

  test("serializes two same-process contenders: loser reuses the winner's result", async () => {
    const lockPath = makeLockPath();
    // Shared "persisted store": the winner's persist() updates it, so the
    // loser's under-lock read sees fresh tokens and skips its own refresh.
    let store = snapshot({
      refreshToken: "shared-refresh",
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
      refreshTokensCoordinated("shared-refresh", deps),
      refreshTokensCoordinated("shared-refresh", deps),
    ]);
    expect(first).toBe("new-access");
    expect(second).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(lockHeld(lockPath)).toBe(false);
  });
});
