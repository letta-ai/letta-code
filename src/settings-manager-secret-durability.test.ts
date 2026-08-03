import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import {
  __setSecretRuntimeOverrideForTests,
  setServiceName,
} from "@/utils/secrets";

/**
 * The settings file is the only credential source a headless process has before
 * secure storage works. Migration deletes it once tokens move into the OS store,
 * so migrating into a session-scoped store strands every process that cannot
 * reach that session - which is the lost-auth symptom the storage work fixes.
 */
describe("token migration and secure storage durability", () => {
  const originalHome = process.env.HOME;
  const originalApiKey = process.env.LETTA_API_KEY;
  const originalSkipCheck = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  let testHome: string;
  let settingsPath: string;

  function createInMemoryBunSecrets() {
    const store = new Map<string, string>();
    return {
      get: ({ service, name }: { service: string; name: string }) =>
        store.get(`${service}/${name}`) ?? null,
      set: ({
        service,
        name,
        value,
      }: {
        service: string;
        name: string;
        value: string;
      }) => {
        store.set(`${service}/${name}`, value);
      },
      delete: ({ service, name }: { service: string; name: string }) =>
        store.delete(`${service}/${name}`),
    };
  }

  async function seedSettingsWithFileTokens(): Promise<void> {
    await mkdir(join(testHome, ".letta"), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          refreshToken: "refresh-from-file",
          env: { LETTA_API_KEY: "key-from-file" },
        },
        null,
        2,
      ),
    );
  }

  async function readPersistedSettings(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
  }

  beforeEach(async () => {
    await settingsManager.reset();
    testHome = await mkdtemp(join(tmpdir(), "letta-secret-durability-"));
    settingsPath = join(testHome, ".letta", "settings.json");
    process.env.HOME = testHome;
    delete process.env.LETTA_API_KEY;
    delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    setServiceName("letta-code-durability-test");
  });

  afterEach(async () => {
    __setSecretRuntimeOverrideForTests(null);
    await settingsManager.reset();
    await rm(testHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = originalApiKey;
    if (originalSkipCheck === undefined)
      delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    else process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkipCheck;
  });

  test("keeps settings-file tokens when secure storage is session-scoped", async () => {
    await seedSettingsWithFileTokens();

    // Linux Secret Service is reached over the session bus, so a credential
    // written here is not readable from a headless process.
    __setSecretRuntimeOverrideForTests({
      platform: "linux",
      bunSecrets: createInMemoryBunSecrets(),
    });

    await settingsManager.initialize();

    const persisted = await readPersistedSettings();
    expect(persisted.refreshToken).toBe("refresh-from-file");
    expect(
      (persisted.env as Record<string, string> | undefined)?.LETTA_API_KEY,
    ).toBe("key-from-file");
  });

  test("removes settings-file tokens when secure storage is durable", async () => {
    await seedSettingsWithFileTokens();

    // macOS Keychain is process-independent, so the fallback is safe to drop.
    __setSecretRuntimeOverrideForTests({
      platform: "darwin",
      bunSecrets: createInMemoryBunSecrets(),
    });

    await settingsManager.initialize();

    const persisted = await readPersistedSettings();
    expect(persisted.refreshToken).toBeUndefined();
    expect(
      (persisted.env as Record<string, string> | undefined)?.LETTA_API_KEY,
    ).toBeUndefined();
  });

  test("migrated tokens stay readable through the settings manager either way", async () => {
    await seedSettingsWithFileTokens();
    __setSecretRuntimeOverrideForTests({
      platform: "linux",
      bunSecrets: createInMemoryBunSecrets(),
    });

    await settingsManager.initialize();

    // Whichever copy survives, the caller must still get a usable credential.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    expect(settings.refreshToken).toBe("refresh-from-file");
    expect(settings.env?.LETTA_API_KEY).toBe("key-from-file");
  });
});
