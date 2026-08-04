import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { refreshAccessToken, type TokenResponse } from "@/auth/oauth";
import { readPersistedAuthTokens } from "@/auth/persisted-tokens";

type RefreshAccessToken = typeof refreshAccessToken;

const inFlightRefreshes = new Map<string, Promise<TokenResponse>>();

/**
 * Refresh a credential no more than once at a time within this process.
 *
 * This is only the first of two layers: it cannot see peer letta processes,
 * so on its own it still lets two invocations rotate the same refresh_token
 * concurrently. Any path that PERSISTS the result must go through
 * {@link refreshTokensCoordinated} instead of calling this directly.
 */
export async function refreshAccessTokenSingleFlight(
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
  refresh: RefreshAccessToken = refreshAccessToken,
): Promise<TokenResponse> {
  const refreshKey = `${refreshToken}\0${deviceId}`;
  const existing = inFlightRefreshes.get(refreshKey);
  if (existing) {
    return await existing;
  }

  const pending = refresh(refreshToken, deviceId, deviceName);
  inFlightRefreshes.set(refreshKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlightRefreshes.get(refreshKey) === pending) {
      inFlightRefreshes.delete(refreshKey);
    }
  }
}

/** Treat a token with less remaining life than this as needing rotation. */
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Lock acquisition gives up after ~20s of retrying. proper-lockfile keeps a
 * live holder's lock fresh by touching its mtime, so `stale` only reaps
 * locks whose holder actually died (crash, SIGKILL) — no hand-rolled
 * staleness math.
 */
const LOCK_RETRIES = {
  retries: 40,
  factor: 1,
  minTimeout: 250,
  maxTimeout: 500,
} as const;
const LOCK_STALE_MS = 15_000;

type SettingsUpdates = {
  env: { LETTA_API_KEY: string };
  refreshToken: string;
  tokenExpiresAt: number;
};

export type CoordinatedRefreshDeps = {
  readTokens?: typeof readPersistedAuthTokens;
  refresh?: (refreshToken: string) => Promise<TokenResponse>;
  /** Persist rotated tokens; defaults to settingsManager update + flush. */
  persist?: (updates: SettingsUpdates) => Promise<void>;
  lockPath?: string;
};

async function defaultRefresh(refreshToken: string): Promise<TokenResponse> {
  const { hostname } = await import("node:os");
  const { settingsManager } = await import("@/settings-manager");
  return refreshAccessTokenSingleFlight(
    refreshToken,
    settingsManager.getOrCreateDeviceId(),
    hostname(),
  );
}

async function defaultPersist(updates: SettingsUpdates): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  settingsManager.updateSettings(updates);
  await settingsManager.flush();
}

function defaultLockPath(): string {
  return join(homedir(), ".letta", "oauth-refresh");
}

/**
 * Refresh OAuth tokens under a cross-process file lock. Every rotating-token
 * call site funnels through here — getClient(), the WebSocket listener, the
 * startup refresh in index.ts, the ChatGPT usage service, and each
 * `letta git-credential` helper invocation spawned by git.
 *
 * The server rotates the refresh token on every refresh
 * (refresh_token_mode: "new"), so two uncoordinated refreshes both spend the
 * same refresh token and race their keychain writes; the loser can durably
 * persist an already-invalidated token and log the user out. The in-process
 * single-flight cannot see other processes; proper-lockfile serializes them.
 *
 * Waiter-reuses-winner: after acquiring the lock, the PERSISTED snapshot is
 * read (settings file + direct keychain, bypassing this process's caches —
 * see readPersistedAuthTokens). Two independent signals mean another process
 * already rotated: a fresh persisted expiry, or a persisted refresh token
 * that differs from the caller's (ours is spent — using it would revoke
 * theirs). Either way the winner's access token is adopted instead of
 * refreshing again.
 *
 * Fails closed: a keychain that errors or times out mid-read throws
 * (KeychainReadError) rather than rotating based on possibly-stale data.
 */
export async function refreshTokensCoordinated(
  fallbackRefreshToken: string,
  deps: CoordinatedRefreshDeps = {},
): Promise<string> {
  const readTokens = deps.readTokens ?? readPersistedAuthTokens;
  const refresh = deps.refresh ?? defaultRefresh;
  const persist = deps.persist ?? defaultPersist;
  const lockPath = deps.lockPath ?? defaultLockPath();

  const release = await lockfile.lock(lockPath, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: LOCK_RETRIES,
  });
  try {
    const before = await readTokens();
    const peerRotated =
      before.apiKey &&
      ((before.tokenExpiresAt !== null &&
        before.tokenExpiresAt - Date.now() >= TOKEN_REFRESH_WINDOW_MS) ||
        (before.refreshToken !== null &&
          fallbackRefreshToken !== "" &&
          before.refreshToken !== fallbackRefreshToken));
    if (peerRotated && before.apiKey) {
      return before.apiKey;
    }

    const now = Date.now();
    // Prefer the persisted refresh token: with rotation, a long-running
    // process's in-memory copy may already be invalidated by a refresh
    // another process performed.
    const refreshTokenToUse = before.refreshToken ?? fallbackRefreshToken;
    if (!refreshTokenToUse) {
      throw new Error("no refresh token available");
    }
    const tokens = await refresh(refreshTokenToUse);
    const rotatedRefreshToken = tokens.refresh_token || refreshTokenToUse;
    await persist({
      env: { LETTA_API_KEY: tokens.access_token },
      refreshToken: rotatedRefreshToken,
      tokenExpiresAt: now + tokens.expires_in * 1000,
    });
    // The rotated refresh token must be durably persisted before the lock
    // releases — the pre-rotation token is already dead server-side, and
    // the persistence path swallows write errors (flush() awaits but never
    // rejects). Verify with the same cache-bypassing snapshot, checking
    // BOTH tokens: a partial keychain write (new access token, old refresh
    // token) would pass an access-only check and strand auth on the next
    // refresh. Only a runtime-scope read-back (keychain reads skipped)
    // cannot verify and is accepted as-is.
    const after = await readTokens();
    if (
      after.source !== "runtime-scope" &&
      (after.apiKey !== tokens.access_token ||
        after.refreshToken !== rotatedRefreshToken)
    ) {
      throw new Error(
        "OAuth refresh succeeded but the rotated tokens failed to persist; if this recurs, re-run `letta` to re-authenticate",
      );
    }
    return tokens.access_token;
  } finally {
    await release();
  }
}
