import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import {
  __setSecretGetOverrideForTests,
  setServiceName,
} from "@/utils/secrets";

describe("settings auth cache", () => {
  const originalHome = process.env.HOME;
  const originalIsKeychainAvailable =
    settingsManager.isKeychainAvailable.bind(settingsManager);
  let testHome: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-auth-cache-"));
    process.env.HOME = testHome;
    setServiceName("letta-code-auth-cache-test");
    await settingsManager.initialize();
    settingsManager.isKeychainAvailable = async () => true;
  });

  afterEach(async () => {
    settingsManager.isKeychainAvailable = originalIsKeychainAvailable;
    __setSecretGetOverrideForTests(null);
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });
    process.env.HOME = originalHome;
    setServiceName("letta-code");
  });

  test("preserves cached tokens when a later keychain read fails", async () => {
    __setSecretGetOverrideForTests(async ({ name }) => {
      if (name === "letta-api-key") return "sk-listener-cache";
      if (name === "letta-refresh-token") return "rt-listener-cache";
      return null;
    });
    await settingsManager.getSettingsWithSecureTokens();

    __setSecretGetOverrideForTests(async () => {
      throw new Error("User interaction is not allowed");
    });

    const settings = await settingsManager.getSettingsWithSecureTokens();
    expect(settings.env?.LETTA_API_KEY).toBe("sk-listener-cache");
    expect(settings.refreshToken).toBe("rt-listener-cache");
  });
});
