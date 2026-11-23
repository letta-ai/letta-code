/// <reference types="bun-types" />

import { debugWarn } from "./debug.js";

const secrets = globalThis.Bun?.secrets;

function scopeServiceName(name: string): string {
  const testPrefix = process.env.LETTA_TEST_SECRETS_SERVICE_PREFIX?.trim();
  return testPrefix ? `${testPrefix}:${name}` : name;
}

let serviceNameOverride: string | undefined;
const API_KEY_NAME = "letta-api-key";
const REFRESH_TOKEN_NAME = "letta-refresh-token";

const warnedSecretReadFailures = new Set<string>();
let secretGetOverrideForTests:
  | ((options: { service: string; name: string }) => Promise<string | null>)
  | null = null;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getServiceName(): string {
  const configured =
    serviceNameOverride ??
    process.env.LETTA_SECRETS_SERVICE_NAME?.trim() ??
    "letta-code";
  return scopeServiceName(configured || "letta-code");
}

function isDuplicateKeychainItemError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return (
    message.includes("already exists in the keychain") ||
    message.includes("code: -25299")
  );
}

export async function getSecretValue(
  name: string,
  label: string,
): Promise<string | null> {
  if (!secrets && !secretGetOverrideForTests) {
    return null;
  }

  try {
    const options = {
      service: getServiceName(),
      name,
    };
    const value = secretGetOverrideForTests
      ? await secretGetOverrideForTests(options)
      : await secrets.get(options);
    warnedSecretReadFailures.delete(name);
    return value;
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
  if (!secrets) {
    throw new Error("Secrets API unavailable");
  }

  try {
    await secrets.set({
      service: getServiceName(),
      name,
      value,
    });
    return;
  } catch (error) {
    if (!isDuplicateKeychainItemError(error)) {
      throw error;
    }
  }

  try {
    await secrets.delete({
      service: getServiceName(),
      name,
    });
  } catch {}

  await secrets.set({
    service: getServiceName(),
    name,
    value,
  });
}

export async function deleteSecretValue(name: string): Promise<boolean> {
  if (!secrets) {
    return false;
  }

  try {
    return await secrets.delete({
      service: getServiceName(),
      name,
    });
  } catch (error) {
    console.warn(`Failed to delete secret ${name}: ${error}`);
    return false;
  }
}

export function setServiceName(name?: string): void {
  serviceNameOverride = name;
}

export interface SecureTokens {
  apiKey?: string;
  refreshToken?: string;
}

export async function setApiKey(apiKey: string): Promise<void> {
  if (!secrets) {
    throw new Error("Secrets API unavailable");
  }

  await setSecretValue(API_KEY_NAME, apiKey);
}

export async function getApiKey(): Promise<string | null> {
  return getSecretValue(API_KEY_NAME, "API key");
}

export async function setRefreshToken(refreshToken: string): Promise<void> {
  if (!secrets) {
    throw new Error("Secrets API unavailable");
  }

  await setSecretValue(REFRESH_TOKEN_NAME, refreshToken);
}

export async function getRefreshToken(): Promise<string | null> {
  return getSecretValue(REFRESH_TOKEN_NAME, "refresh token");
}

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

export async function deleteApiKey(): Promise<void> {
  if (secrets) {
    try {
      await secrets.delete({
        service: getServiceName(),
        name: API_KEY_NAME,
      });
      return;
    } catch (error) {
      console.warn(`Failed to delete API key from secrets: ${error}`);
    }
  }
}

export async function deleteRefreshToken(): Promise<void> {
  if (secrets) {
    try {
      await secrets.delete({
        service: getServiceName(),
        name: REFRESH_TOKEN_NAME,
      });
      return;
    } catch (error) {
      console.warn(`Failed to delete refresh token from secrets: ${error}`);
    }
  }
}

export async function deleteSecureTokens(): Promise<void> {
  await Promise.allSettled([deleteApiKey(), deleteRefreshToken()]);
}

export async function isKeychainAvailable(): Promise<boolean> {
  if (process.env.LETTA_SKIP_KEYCHAIN_CHECK === "1") {
    return false;
  }

  if (
    process.platform === "linux" &&
    !process.env.DBUS_SESSION_BUS_ADDRESS?.trim()
  ) {
    return false;
  }

  if (!secrets) {
    return false;
  }

  try {
    await secrets.get({
      service: getServiceName(),
      name: API_KEY_NAME,
    });
    return true;
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
