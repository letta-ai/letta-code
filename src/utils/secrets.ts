/// <reference types="bun-types" />
// src/utils/secrets.ts
// Secure storage utilities for tokens using Bun's secrets API, with a
// Windows Credential Manager fallback for the npm/Node CLI runtime.

import { debugWarn } from "./debug.js";
import {
  deleteWindowsCredential,
  getWindowsCredential,
  getWindowsCredentials,
  isWindowsCredentialManagerAvailable,
  setWindowsCredential,
} from "./windows-credential-manager.js";

type BunSecrets = typeof Bun.secrets;

interface SecretBackend {
  kind: "bun" | "windows-credential-manager";
  get(options: { service: string; name: string }): Promise<string | null>;
  getMany?(options: {
    service: string;
    names: string[];
  }): Promise<Record<string, string | null>>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

let SERVICE_NAME = "letta-code";
const API_KEY_NAME = "letta-api-key";
const REFRESH_TOKEN_NAME = "letta-refresh-token";

const warnedSecretReadFailures = new Set<string>();
let secretGetOverrideForTests:
  | ((options: { service: string; name: string }) => Promise<string | null>)
  | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDuplicateKeychainItemError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("already exists in the keychain") ||
    message.includes("code: -25299")
  );
}

function getBunSecrets(): BunSecrets | null {
  const runtime = globalThis as typeof globalThis & {
    Bun?: { secrets?: BunSecrets };
  };
  return runtime.Bun?.secrets ?? null;
}

function getSecretBackend(): SecretBackend | null {
  const bunSecrets = getBunSecrets();
  if (bunSecrets) {
    return {
      kind: "bun",
      get: (options) => bunSecrets.get(options),
      set: (options) => bunSecrets.set(options),
      delete: (options) => bunSecrets.delete(options),
      isAvailable: async () => {
        await bunSecrets.get({
          service: SERVICE_NAME,
          name: API_KEY_NAME,
        });
        return true;
      },
    };
  }

  if (process.platform === "win32") {
    return {
      kind: "windows-credential-manager",
      get: (options) => getWindowsCredential(options.service, options.name),
      getMany: (options) =>
        getWindowsCredentials(options.service, options.names),
      set: (options) =>
        setWindowsCredential(options.service, options.name, options.value),
      delete: (options) =>
        deleteWindowsCredential(options.service, options.name),
      isAvailable: () => isWindowsCredentialManagerAvailable(),
    };
  }

  return null;
}

export async function getSecretValue(
  name: string,
  label: string,
): Promise<string | null> {
  const backend = getSecretBackend();
  if (!backend && !secretGetOverrideForTests) {
    return null;
  }

  try {
    const options = {
      service: SERVICE_NAME,
      name,
    };
    const value = secretGetOverrideForTests
      ? await secretGetOverrideForTests(options)
      : await backend?.get(options);
    warnedSecretReadFailures.delete(name);
    return value ?? null;
  } catch (error) {
    const message = `Failed to retrieve ${label} from secrets: ${error}`;
    if (!warnedSecretReadFailures.has(name)) {
      warnedSecretReadFailures.add(name);
      console.warn(message);
    } else {
      debugWarn("secrets", message);
    }
    return null;
  }
}

export async function setSecretValue(
  name: string,
  value: string,
): Promise<void> {
  const backend = getSecretBackend();
  if (!backend) {
    throw new Error("Secrets API unavailable");
  }

  try {
    await backend.set({
      service: SERVICE_NAME,
      name,
      value,
    });
    return;
  } catch (error) {
    if (backend.kind !== "bun" || !isDuplicateKeychainItemError(error)) {
      throw error;
    }
  }

  // Replace existing keychain item and retry once.
  try {
    await backend.delete({
      service: SERVICE_NAME,
      name,
    });
  } catch {
    // Ignore delete errors and retry set below.
  }

  await backend.set({
    service: SERVICE_NAME,
    name,
    value,
  });
}

export async function deleteSecretValue(name: string): Promise<boolean> {
  const backend = getSecretBackend();
  if (!backend) {
    return false;
  }

  try {
    return await backend.delete({
      service: SERVICE_NAME,
      name,
    });
  } catch (error) {
    console.warn(`Failed to delete secret ${name}: ${error}`);
    return false;
  }
}

/**
 * Override the keychain service name (useful for tests to avoid touching real credentials)
 */
export function setServiceName(name: string): void {
  SERVICE_NAME = name;
}

// Note: On platforms without an OS secret backend, tokens are managed by the
// settings manager fallback so authentication still persists across restarts.

export interface SecureTokens {
  apiKey?: string;
  refreshToken?: string;
}

/**
 * Store API key in system secrets
 */
export async function setApiKey(apiKey: string): Promise<void> {
  await setSecretValue(API_KEY_NAME, apiKey);
}

/**
 * Retrieve API key from system secrets
 */
export async function getApiKey(): Promise<string | null> {
  return getSecretValue(API_KEY_NAME, "API key");
}

/**
 * Store refresh token in system secrets
 */
export async function setRefreshToken(refreshToken: string): Promise<void> {
  await setSecretValue(REFRESH_TOKEN_NAME, refreshToken);
}

/**
 * Retrieve refresh token from system secrets
 */
export async function getRefreshToken(): Promise<string | null> {
  return getSecretValue(REFRESH_TOKEN_NAME, "refresh token");
}

/**
 * Get both tokens from secrets
 */
export async function getSecureTokens(): Promise<SecureTokens> {
  const backend = getSecretBackend();
  if (!secretGetOverrideForTests && backend?.getMany) {
    try {
      const values = await backend.getMany({
        service: SERVICE_NAME,
        names: [API_KEY_NAME, REFRESH_TOKEN_NAME],
      });
      warnedSecretReadFailures.delete(API_KEY_NAME);
      warnedSecretReadFailures.delete(REFRESH_TOKEN_NAME);
      return {
        apiKey: values[API_KEY_NAME] || undefined,
        refreshToken: values[REFRESH_TOKEN_NAME] || undefined,
      };
    } catch (error) {
      const message = `Failed to retrieve secure tokens from secrets: ${error}`;
      if (
        !warnedSecretReadFailures.has(API_KEY_NAME) ||
        !warnedSecretReadFailures.has(REFRESH_TOKEN_NAME)
      ) {
        warnedSecretReadFailures.add(API_KEY_NAME);
        warnedSecretReadFailures.add(REFRESH_TOKEN_NAME);
        console.warn(message);
      } else {
        debugWarn("secrets", message);
      }
      return {};
    }
  }

  const [apiKey, refreshToken] = await Promise.allSettled([
    getApiKey(),
    getRefreshToken(),
  ]);

  return {
    apiKey:
      apiKey.status === "fulfilled" ? apiKey.value || undefined : undefined,
    refreshToken:
      refreshToken.status === "fulfilled"
        ? refreshToken.value || undefined
        : undefined,
  };
}

/**
 * Store both tokens in secrets
 */
export async function setSecureTokens(tokens: SecureTokens): Promise<void> {
  const promises: Promise<void>[] = [];

  if (tokens.apiKey) {
    promises.push(setApiKey(tokens.apiKey));
  }

  if (tokens.refreshToken) {
    promises.push(setRefreshToken(tokens.refreshToken));
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}

/**
 * Remove API key from system secrets
 */
export async function deleteApiKey(): Promise<void> {
  await deleteSecretValue(API_KEY_NAME);
}

/**
 * Remove refresh token from system secrets
 */
export async function deleteRefreshToken(): Promise<void> {
  await deleteSecretValue(REFRESH_TOKEN_NAME);
}

/**
 * Remove all tokens from system secrets
 */
export async function deleteSecureTokens(): Promise<void> {
  await Promise.allSettled([deleteApiKey(), deleteRefreshToken()]);
}

/**
 * Check if secrets API is available
 * Set LETTA_SKIP_KEYCHAIN_CHECK=1 to skip the check (useful in CI/test environments)
 */
export async function isKeychainAvailable(): Promise<boolean> {
  // Skip keychain check in test/CI environments to avoid error dialogs
  if (process.env.LETTA_SKIP_KEYCHAIN_CHECK === "1") {
    return false;
  }

  // Headless Linux environments frequently lack a session bus, so avoid
  // probing the keychain when Secret Service cannot work.
  if (
    process.platform === "linux" &&
    !process.env.DBUS_SESSION_BUS_ADDRESS?.trim()
  ) {
    return false;
  }

  const backend = getSecretBackend();
  if (!backend) {
    return false;
  }

  try {
    // Non-mutating probe: if this call succeeds (even with null), keychain is usable.
    return await backend.isAvailable();
  } catch {
    return false;
  }
}

export function __resetSecretWarningStateForTests(): void {
  warnedSecretReadFailures.clear();
}

export function __setSecretGetOverrideForTests(
  override:
    | ((options: { service: string; name: string }) => Promise<string | null>)
    | null,
): void {
  secretGetOverrideForTests = override;
}
