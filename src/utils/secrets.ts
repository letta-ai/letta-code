/// <reference types="bun-types" />
// src/utils/secrets.ts
// Secure storage utilities for tokens and local agent secrets. Consumers stay on
// this boundary; runtime-specific OS storage lives behind SecretBackend.

import { debugWarn } from "./debug.js";
import {
  createExplicitNodeSecretBackend,
  getSecretBackend,
  __getSelectedSecretBackendKindForTests as getSelectedSecretBackendKindForTests,
  __getWindowsCredentialScriptForTests as getWindowsCredentialScriptForTests,
  type SecretBackend,
  type SecretBackendKind,
  __setSecretRuntimeOverrideForTests as setSecretRuntimeOverrideForTests,
} from "./secret-backends.js";

const DEFAULT_SERVICE_NAME = "letta-code";
let SERVICE_NAME = DEFAULT_SERVICE_NAME;
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

function getBackendOrThrow(): SecretBackend {
  const backend = getSecretBackend();
  if (!backend) {
    throw new Error("Secrets API unavailable");
  }
  return backend;
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
  const backend = getBackendOrThrow();

  // Bun.secrets treats an empty value as deletion on every platform. Keep the
  // explicit Node backends behaviorally identical instead of storing an empty
  // credential that only one runtime can observe.
  if (value === "") {
    await backend.delete({
      service: SERVICE_NAME,
      name,
    });
    return;
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

  // Preserve Bun.secrets duplicate-item replacement behavior for existing
  // macOS entries: delete the exact shared entry and retry once.
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
 * Check if OS secure storage is available.
 * Set LETTA_SKIP_KEYCHAIN_CHECK=1 to skip the check (useful in CI/test environments).
 */
export async function isKeychainAvailable(): Promise<boolean> {
  if (process.env.LETTA_SKIP_KEYCHAIN_CHECK === "1") {
    return false;
  }

  const backend = getSecretBackend();
  if (!backend) {
    return false;
  }

  try {
    // Non-mutating probe: if this call succeeds (even with null), secure
    // storage is usable. Do not cache failures; Linux DBus/keyring availability
    // can change during the process lifetime.
    return await backend.isAvailable({
      service: SERVICE_NAME,
      name: API_KEY_NAME,
    });
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

export function __getDefaultServiceNameForTests(): string {
  return DEFAULT_SERVICE_NAME;
}

export function __setSecretRuntimeOverrideForTests(
  override: Parameters<typeof setSecretRuntimeOverrideForTests>[0],
): void {
  setSecretRuntimeOverrideForTests(override);
}

export function __getSelectedSecretBackendKindForTests(): SecretBackendKind | null {
  return getSelectedSecretBackendKindForTests();
}

export function __getWindowsCredentialScriptForTests(): string {
  return getWindowsCredentialScriptForTests();
}

export function __getExplicitNodeSecretBackendForTests(
  platform: NodeJS.Platform = process.platform,
): SecretBackend | null {
  return createExplicitNodeSecretBackend(platform);
}
