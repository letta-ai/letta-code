import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveSettings as saveLegacySettings } from "@/settings";
import { settingsManager } from "@/settings-manager";
import {
  resolveGlobalConfigDir,
  resolveGlobalSettingsPath,
} from "@/utils/settings-path";

const originalHome = process.env.HOME;
const originalConfigDir = process.env.LETTA_CONFIG_DIR;
const originalSkipKeychain = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-settings-path-"));
  process.env.HOME = testHomeDir;
  delete process.env.LETTA_CONFIG_DIR;
  process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
});

afterEach(async () => {
  await settingsManager.reset();
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
  else process.env.LETTA_CONFIG_DIR = originalConfigDir;
  if (originalSkipKeychain === undefined)
    delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  else process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkipKeychain;
});

describe("global settings path", () => {
  test("defaults to the existing ~/.letta settings file", () => {
    expect(resolveGlobalSettingsPath({}, "/Users/alice")).toBe(
      join("/Users/alice", ".letta", "settings.json"),
    );
  });

  test("accepts an absolute host-provided settings path", () => {
    expect(
      resolveGlobalConfigDir(
        { LETTA_CONFIG_DIR: "/Users/alice/.dream" },
        "/fallback",
      ),
    ).toBe(join("/Users/alice", ".dream"));
    expect(
      resolveGlobalSettingsPath(
        { LETTA_CONFIG_DIR: "/Users/alice/.dream" },
        "/fallback",
      ),
    ).toBe(join("/Users/alice", ".dream", "settings.json"));
  });

  test("rejects a relative host-provided settings path", () => {
    expect(() =>
      resolveGlobalSettingsPath({ LETTA_CONFIG_DIR: ".dream" }, "/fallback"),
    ).toThrow("LETTA_CONFIG_DIR must be absolute");
  });

  test("persists file-backed credentials only at the host-provided path", async () => {
    const settingsPath = join(testHomeDir, ".dream", "settings.json");
    const lettaSettingsPath = join(testHomeDir, ".letta", "settings.json");
    process.env.LETTA_CONFIG_DIR = join(testHomeDir, ".dream");
    await Bun.write(lettaSettingsPath, JSON.stringify({ sentinel: "letta" }));

    await settingsManager.initialize();
    settingsManager.updateSettings({
      env: { LETTA_API_KEY: "dream-access-token" },
      preferredBackendMode: "api",
      refreshToken: "dream-refresh-token",
      tokenExpiresAt: 123,
    });
    await settingsManager.flush();

    const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, string>;
      refreshToken?: string;
      tokenExpiresAt?: number;
    };
    expect(persisted.env?.LETTA_API_KEY).toBe("dream-access-token");
    expect(persisted.refreshToken).toBe("dream-refresh-token");
    expect(persisted.tokenExpiresAt).toBe(123);
    expect(settingsManager.readStartupBackendSettingsSync()).toEqual({
      preferredBackendMode: "api",
      envBaseUrl: undefined,
    });
    expect(await readFile(lettaSettingsPath, "utf8")).toBe(
      JSON.stringify({ sentinel: "letta" }),
    );

    if (process.platform !== "win32") {
      expect((await stat(join(testHomeDir, ".dream"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    }

    await settingsManager.logout();
    const signedOut = JSON.parse(await readFile(settingsPath, "utf8")) as {
      env?: Record<string, string>;
      refreshToken?: string;
    };
    expect(signedOut.env?.LETTA_API_KEY).toBeUndefined();
    expect(signedOut.refreshToken).toBeUndefined();
    expect(await readFile(lettaSettingsPath, "utf8")).toBe(
      JSON.stringify({ sentinel: "letta" }),
    );
  });

  test("routes the legacy global settings writer through the same config directory", async () => {
    process.env.LETTA_CONFIG_DIR = join(testHomeDir, ".dream");

    await saveLegacySettings({
      globalSharedBlockIds: {},
      lastAgent: "agent-dream",
      tokenStreaming: false,
    });

    expect(
      JSON.parse(
        await readFile(join(testHomeDir, ".dream", "settings.json"), "utf8"),
      ),
    ).toMatchObject({ lastAgent: "agent-dream" });
    expect(existsSync(join(testHomeDir, ".letta", "settings.json"))).toBe(
      false,
    );
  });
});
