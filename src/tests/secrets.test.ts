// src/tests/keychain.test.ts
// Tests for secrets utility functions

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  deleteApiKey,
  deleteRefreshToken,
  deleteSecureTokens,
  getApiKey,
  getRefreshToken,
  getSecureTokens,
  isKeychainAvailable,
  type SecureTokens,
  setApiKey,
  setRefreshToken,
  setSecureTokens,
  keychainAvailablePrecompute
} from "../utils/secrets";

describe("Secrets utilities", () => {
  beforeEach(async () => {
    if (keychainAvailablePrecompute) {
      await deleteSecureTokens();
    }
  });

  afterEach(async () => {
    if (keychainAvailablePrecompute) {
      await deleteSecureTokens();
    }
  });

  test("isKeychainAvailable works", async () => {
    const available = await isKeychainAvailable();
    expect(typeof available).toBe("boolean");
  });

  test.skipIf(!keychainAvailablePrecompute)(
    "can store and retrieve API key",
    async () => {
      const testApiKey = "sk-test-api-key-12345";

      await setApiKey(testApiKey);
      const retrievedApiKey = await getApiKey();

      expect(retrievedApiKey).toBe(testApiKey);
    },
  );

  test.skipIf(!keychainAvailablePrecompute)(
    "can store and retrieve refresh token",
    async () => {
      const testRefreshToken = "rt-test-refresh-token-67890";

      await setRefreshToken(testRefreshToken);
      const retrievedRefreshToken = await getRefreshToken();

      expect(retrievedRefreshToken).toBe(testRefreshToken);
    },
  );

  test.skipIf(!keychainAvailablePrecompute)(
    "can store and retrieve both tokens together",
    async () => {
      const tokens: SecureTokens = {
        apiKey: "sk-test-api-key-combined",
        refreshToken: "rt-test-refresh-token-combined",
      };

      await setSecureTokens(tokens);
      const retrievedTokens = await getSecureTokens();

      expect(retrievedTokens.apiKey).toBe(tokens.apiKey);
      expect(retrievedTokens.refreshToken).toBe(tokens.refreshToken);
    },
  );

  test.skipIf(!keychainAvailablePrecompute)("can delete API key", async () => {
    const testApiKey = "sk-test-api-key-delete";

    await setApiKey(testApiKey);
    let retrievedApiKey = await getApiKey();
    expect(retrievedApiKey).toBe(testApiKey);

    await deleteApiKey();
    retrievedApiKey = await getApiKey();
    expect(retrievedApiKey).toBe(null);
  });

  test.skipIf(!keychainAvailablePrecompute)("can delete refresh token", async () => {
    const testRefreshToken = "rt-test-refresh-token-delete";

    await setRefreshToken(testRefreshToken);
    let retrievedRefreshToken = await getRefreshToken();
    expect(retrievedRefreshToken).toBe(testRefreshToken);

    await deleteRefreshToken();
    retrievedRefreshToken = await getRefreshToken();
    expect(retrievedRefreshToken).toBe(null);
  });

  test.skipIf(!keychainAvailablePrecompute)("can delete all tokens", async () => {
    const tokens: SecureTokens = {
      apiKey: "sk-test-api-key-delete-all",
      refreshToken: "rt-test-refresh-token-delete-all",
    };

    await setSecureTokens(tokens);
    let retrievedTokens = await getSecureTokens();
    expect(retrievedTokens.apiKey).toBe(tokens.apiKey);
    expect(retrievedTokens.refreshToken).toBe(tokens.refreshToken);

    await deleteSecureTokens();
    retrievedTokens = await getSecureTokens();
    expect(retrievedTokens.apiKey).toBeUndefined();
    expect(retrievedTokens.refreshToken).toBeUndefined();
  });

  test.skipIf(!keychainAvailablePrecompute)(
    "returns null for non-existent tokens",
    async () => {
      // Ensure no tokens exist
      await deleteSecureTokens();

      const apiKey = await getApiKey();
      const refreshToken = await getRefreshToken();
      const tokens = await getSecureTokens();

      expect(apiKey).toBe(null);
      expect(refreshToken).toBe(null);
      expect(tokens.apiKey).toBeUndefined();
      expect(tokens.refreshToken).toBeUndefined();
    },
  );

  test.skipIf(!keychainAvailablePrecompute)("handles partial token storage", async () => {
    // Store only API key
    await setSecureTokens({ apiKey: "sk-only-api-key" });

    let tokens = await getSecureTokens();
    expect(tokens.apiKey).toBe("sk-only-api-key");
    expect(tokens.refreshToken).toBeUndefined();

    // Clean up and store only refresh token
    await deleteSecureTokens();
    await setSecureTokens({ refreshToken: "rt-only-refresh-token" });

    tokens = await getSecureTokens();
    expect(tokens.apiKey).toBeUndefined();
    expect(tokens.refreshToken).toBe("rt-only-refresh-token");
  });

  test("gracefully handles secrets unavailability", async () => {
    // This test should work even if secrets are not available
    if (await isKeychainAvailable()) {
      // If secrets are available, this is a basic functionality test
      const tokens = await getSecureTokens();
      expect(typeof tokens).toBe("object");
    } else {
      // If secrets are not available, functions should return null or throw appropriately
      const tokens = await getSecureTokens();
      expect(tokens.apiKey).toBeUndefined();
      expect(tokens.refreshToken).toBeUndefined();

      const apiKey = await getApiKey();
      expect(apiKey).toBe(null);

      const refreshToken = await getRefreshToken();
      expect(refreshToken).toBe(null);

      // Set operations should throw when secrets unavailable (handled by settings manager)
      await expect(setSecureTokens({ apiKey: "test" })).rejects.toThrow();
      await expect(setApiKey("test")).rejects.toThrow();
      await expect(setRefreshToken("test")).rejects.toThrow();

      // Delete operations should not throw (no-op when secrets unavailable)
      await expect(deleteSecureTokens()).resolves.toBeUndefined();
      await expect(deleteApiKey()).resolves.toBeUndefined();
      await expect(deleteRefreshToken()).resolves.toBeUndefined();
    }
  });
});
