/// <reference types="bun-types" />
// src/utils/secrets.ts
// Secure storage utilities for tokens using Bun's secrets API with Node.js fallback

let secrets: typeof Bun.secrets;
let secretsAvailable = false;

// Try to import Bun's secrets API, fallback if unavailable
try {
  secrets = require("bun").secrets;
  secretsAvailable = true;
} catch {
  // Running in Node.js or Bun secrets unavailable
  secretsAvailable = false;
}

const SERVICE_NAME = "letta-code";
const API_KEY_NAME = "letta-api-key";
const REFRESH_TOKEN_NAME = "letta-refresh-token";

// Note: When secrets API is unavailable (Node.js), tokens will be managed
// by the settings manager which falls back to storing in the settings file
// This provides persistence across restarts

export interface SecureTokens {
  apiKey?: string;
  refreshToken?: string;
}

/**
 * Store API key in system secrets
 */
export async function setApiKey(apiKey: string): Promise<void> {
  if (secretsAvailable) {
    try {
      await secrets.set({
        service: SERVICE_NAME,
        name: API_KEY_NAME,
        value: apiKey,
      });
      return;
    } catch (error) {
      console.warn(
        `Failed to store API key in secrets, using fallback: ${error}`,
      );
    }
  }

  // When secrets unavailable, let the settings manager handle fallback
  throw new Error("Secrets API unavailable");
}

/**
 * Retrieve API key from system secrets
 */
export async function getApiKey(): Promise<string | null> {
  if (secretsAvailable) {
    try {
      return await secrets.get({
        service: SERVICE_NAME,
        name: API_KEY_NAME,
      });
    } catch (error) {
      console.warn(`Failed to retrieve API key from secrets: ${error}`);
    }
  }

  // When secrets unavailable, return null (settings manager will use fallback)
  return null;
}

/**
 * Store refresh token in system secrets
 */
export async function setRefreshToken(refreshToken: string): Promise<void> {
  if (secretsAvailable) {
    try {
      await secrets.set({
        service: SERVICE_NAME,
        name: REFRESH_TOKEN_NAME,
        value: refreshToken,
      });
      return;
    } catch (error) {
      console.warn(
        `Failed to store refresh token in secrets, using fallback: ${error}`,
      );
    }
  }

  // When secrets unavailable, let the settings manager handle fallback
  throw new Error("Secrets API unavailable");
}

/**
 * Retrieve refresh token from system secrets
 */
export async function getRefreshToken(): Promise<string | null> {
  if (secretsAvailable) {
    try {
      return await secrets.get({
        service: SERVICE_NAME,
        name: REFRESH_TOKEN_NAME,
      });
    } catch (error) {
      console.warn(`Failed to retrieve refresh token from secrets: ${error}`);
    }
  }

  // When secrets unavailable, return null (settings manager will use fallback)
  return null;
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
  if (secretsAvailable) {
    try {
      await secrets.delete({
        service: SERVICE_NAME,
        name: API_KEY_NAME,
      });
      return;
    } catch (error) {
      console.warn(`Failed to delete API key from secrets: ${error}`);
    }
  }

  // When secrets unavailable, deletion is handled by settings manager
  // No action needed here
}

/**
 * Remove refresh token from system secrets
 */
export async function deleteRefreshToken(): Promise<void> {
  if (secretsAvailable) {
    try {
      await secrets.delete({
        service: SERVICE_NAME,
        name: REFRESH_TOKEN_NAME,
      });
      return;
    } catch (error) {
      console.warn(`Failed to delete refresh token from secrets: ${error}`);
    }
  }

  // When secrets unavailable, deletion is handled by settings manager
  // No action needed here
}

/**
 * Remove all tokens from system secrets
 */
export async function deleteSecureTokens(): Promise<void> {
  await Promise.allSettled([deleteApiKey(), deleteRefreshToken()]);
}

/**
 * Check if secrets API is available
 */
export async function isKeychainAvailable(): Promise<boolean> {
  if (!secretsAvailable) {
    return false;
  }

  try {
    // Try to set and delete a test value
    const testName = "test-availability";
    const testValue = "test";

    await secrets.set({
      service: SERVICE_NAME,
      name: testName,
      value: testValue,
    });

    await secrets.delete({
      service: SERVICE_NAME,
      name: testName,
    });

    return true;
  } catch {
    return false;
  }
}

/** Const value of isKeychainAvailable
 * Precomputed for tests
 */
 export const keychainAvailablePrecompute = await isKeychainAvailable();
