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
   * Where the token values came from:
   * - "keychain" — direct keychain read succeeded; values are authoritative
   *   and a post-persist read-back can verify against them.
   * - "file" — the keychain is genuinely unavailable on this install, so the
   *   settings file IS durable token storage (persistSettingsAndTokens falls
   *   back to it); values are authoritative and verifiable.
   * - "runtime-scope" — keychain reads are skipped inside runtime scopes
   *   (Bun 1.3.0 can crash there — same guard as
   *   settingsManager.getSettingsWithSecureTokens), so on keychain installs
   *   the file carries only the expiry. Values may be incomplete; callers
   *   must not use them to verify persistence.
   *
   * A keychain that is available but errors or times out mid-read does NOT
   * degrade to "file" — readPersistedAuthTokens throws KeychainReadError
   * instead, so callers fail closed rather than rotate a refresh token based
   * on possibly-stale data.
   */
  source: "keychain" | "file" | "runtime-scope";
}

/** A confirmed-available keychain failed or timed out mid-read. */
export class KeychainReadError extends Error {}

/**
 * Keychain reads run while the refresh lock is held; a wedged keychain must
 * not hold the lock indefinitely, so cap the read. Expiry fails closed (see
 * KeychainReadError) — it never silently degrades to the file snapshot.
 */
const KEYCHAIN_READ_TIMEOUT_MS = 5_000;

function defaultSettingsFilePath(): string {
  // Mirrors settingsManager.getSettingsPath().
  const home = process.env.HOME || homedir();
  return join(home, ".letta", "settings.json");
}

function withReadDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KeychainReadError(`keychain read timed out (${ms}ms)`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(
          new KeychainReadError(
            `keychain read failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
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

  const fileValues = {
    apiKey: fileApiKey,
    refreshToken: fileRefreshToken,
    tokenExpiresAt: fileTokenExpiresAt,
  };

  if (getRuntimeContext()) {
    return { ...fileValues, source: "runtime-scope" };
  }

  // isKeychainAvailable() reports genuine unavailability (no Bun secrets,
  // headless Linux without a session bus, LETTA_SKIP_KEYCHAIN_CHECK) as
  // false — that is the file-fallback install, where the settings file is
  // the durable store. Errors past that point are a different animal.
  const available = await withReadDeadline(
    isKeychainAvailable(),
    KEYCHAIN_READ_TIMEOUT_MS,
  );
  if (!available) {
    return { ...fileValues, source: "file" };
  }

  const [apiKey, refreshToken] = await withReadDeadline(
    Promise.all([getApiKey(), getRefreshToken()]),
    KEYCHAIN_READ_TIMEOUT_MS,
  );

  return {
    // Keychain owns the tokens when populated; the file values only matter
    // for installs that never migrated into the keychain.
    apiKey: apiKey ?? fileApiKey,
    refreshToken: refreshToken ?? fileRefreshToken,
    tokenExpiresAt: fileTokenExpiresAt,
    source: "keychain",
  };
}
