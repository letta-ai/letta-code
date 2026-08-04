/**
 * Durable auth snapshot for the cross-process OAuth refresh lock.
 *
 * The refresh lock's waiter-reuses-winner logic must observe what another
 * PROCESS persisted, so this reader deliberately bypasses every in-process
 * cache: `tokenExpiresAt` comes from the settings file on disk (not
 * settingsManager's in-memory copy, which is stale the moment another
 * process refreshes), and the tokens come from a direct keychain read (not
 * the secure-token cache, which setSecureTokens updates even when the
 * underlying write fails).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import {
  getApiKey,
  getRefreshToken,
  isKeychainAvailable,
} from "@/utils/secrets";

export interface PersistedAuthTokens {
  apiKey: string | null;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  /**
   * True when the keychain was actually consulted. False inside runtime
   * scopes (Bun 1.3.0 can crash on keychain reads there — same guard as
   * settingsManager.getSettingsWithSecureTokens), when the keychain is
   * unavailable (file-fallback installs), or when the read timed out.
   * Non-strict values come from the settings file and may be incomplete;
   * callers must not use them to verify persistence.
   */
  strict: boolean;
}

/**
 * Keychain reads run while the refresh lock is held; a wedged keychain must
 * not hold the lock past its stale-reap window, so cap the read and degrade
 * to the file-backed (non-strict) snapshot.
 */
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

function defaultSettingsFilePath(): string {
  // Mirrors settingsManager.getSettingsPath().
  const home = process.env.HOME || homedir();
  return join(home, ".letta", "settings.json");
}

function withSoftTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

export async function readPersistedAuthTokens(
  settingsFilePath: string = defaultSettingsFilePath(),
): Promise<PersistedAuthTokens> {
  let fileApiKey: string | null = null;
  let fileRefreshToken: string | null = null;
  let fileTokenExpiresAt: number | null = null;
  try {
    const raw = JSON.parse(await readFile(settingsFilePath, "utf-8")) as {
      tokenExpiresAt?: unknown;
      refreshToken?: unknown;
      env?: { LETTA_API_KEY?: unknown };
    };
    if (typeof raw.tokenExpiresAt === "number") {
      fileTokenExpiresAt = raw.tokenExpiresAt;
    }
    if (typeof raw.refreshToken === "string" && raw.refreshToken) {
      fileRefreshToken = raw.refreshToken;
    }
    if (typeof raw.env?.LETTA_API_KEY === "string" && raw.env.LETTA_API_KEY) {
      fileApiKey = raw.env.LETTA_API_KEY;
    }
  } catch {
    // Missing or unreadable settings file — every field stays null.
  }

  const fileOnly: PersistedAuthTokens = {
    apiKey: fileApiKey,
    refreshToken: fileRefreshToken,
    tokenExpiresAt: fileTokenExpiresAt,
    strict: false,
  };

  if (getRuntimeContext()) {
    return fileOnly;
  }

  const keychain = await withSoftTimeout(
    (async () => {
      if (!(await isKeychainAvailable())) return null;
      const [apiKey, refreshToken] = await Promise.all([
        getApiKey(),
        getRefreshToken(),
      ]);
      return { apiKey, refreshToken };
    })(),
    KEYCHAIN_READ_TIMEOUT_MS,
  );
  if (!keychain) {
    return fileOnly;
  }

  return {
    // Keychain owns the tokens when populated; the file values only matter
    // for installs that never migrated into the keychain.
    apiKey: keychain.apiKey ?? fileApiKey,
    refreshToken: keychain.refreshToken ?? fileRefreshToken,
    tokenExpiresAt: fileTokenExpiresAt,
    strict: true,
  };
}
