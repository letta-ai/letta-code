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
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalIsKeychainAvailable =
    settingsManager.isKeychainAvailable.bind(settingsManager);
  let testHome: string;

  beforeEach(async () => {
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-auth-cache-"));
    process.env.HOME = testHome;
    delete process.env.LETTA_API_KEY;
    setServiceName("letta-code-auth-cache-test");
    settingsManager.isKeychainAvailable = async () => true;
    await settingsManager.initialize();
  });

  afterEach(async () => {
    settingsManager.isKeychainAvailable = originalIsKeychainAvailable;
    __setSecretGetOverrideForTests(null);
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });
    process.env.HOME = originalHome;
    if (originalApiKey === undefined) {
      delete process.env.LETTA_API_KEY;
    } else {
      process.env.LETTA_API_KEY = originalApiKey;
    }
    setServiceName("letta-code");
  });

  test("hydrates secure tokens once across concurrent and later reads", async () => {
    let reads = 0;
    __setSecretGetOverrideForTests(async ({ name }) => {
      reads += 1;
      if (name === "letta-api-key") return "sk-listener-cache";
      if (name === "letta-refresh-token") return "rt-listener-cache";
      return null;
    });
    const initialSettings = await Promise.all([
      settingsManager.getSettingsWithSecureTokens(),
      settingsManager.getSettingsWithSecureTokens(),
      settingsManager.getSettingsWithSecureTokens(),
    ]);

    expect(reads).toBe(2);
    for (const settings of initialSettings) {
      expect(settings.env?.LETTA_API_KEY).toBe("sk-listener-cache");
      expect(settings.refreshToken).toBe("rt-listener-cache");
    }

    __setSecretGetOverrideForTests(async () => {
      throw new Error("hydrated tokens must come from memory");
    });

    const settings = await settingsManager.getSettingsWithSecureTokens();
    expect(settings.env?.LETTA_API_KEY).toBe("sk-listener-cache");
    expect(settings.refreshToken).toBe("rt-listener-cache");
    expect(reads).toBe(2);
  });

  test("skips Keychain availability and hydration for an environment API key", async () => {
    let availabilityChecks = 0;
    let reads = 0;
    await settingsManager.reset();
    settingsManager.isKeychainAvailable = async () => {
      availabilityChecks += 1;
      return true;
    };
    __setSecretGetOverrideForTests(async () => {
      reads += 1;
      return "must-not-be-read";
    });
    process.env.LETTA_API_KEY = "sk-environment-authoritative";
    await settingsManager.initialize();

    const settings = await settingsManager.getSettingsWithSecureTokens();
    await settingsManager.getSettingsWithSecureTokens();

    expect(availabilityChecks).toBe(0);
    expect(reads).toBe(0);
    expect(settings.env?.LETTA_API_KEY).toBe("sk-environment-authoritative");
  });
});
