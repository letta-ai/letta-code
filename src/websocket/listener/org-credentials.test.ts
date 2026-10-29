import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveOrgDeviceId,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

describe("organization listener credentials", () => {
  const originalHome = process.env.HOME;
  const originalSkipKeychain = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  const originalConfigDir = process.env.LETTA_CONFIG_DIR;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "letta-org-credentials-"));
    process.env.HOME = home;
    process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
    delete process.env.LETTA_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalSkipKeychain === undefined) {
      delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    } else {
      process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkipKeychain;
    }
    if (originalConfigDir === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = originalConfigDir;
    rmSync(home, { recursive: true, force: true });
  });

  test("derives a stable device id per organization", () => {
    const first = deriveOrgDeviceId("device-id", "org-1");
    expect(first).toBe(deriveOrgDeviceId("device-id", "org-1"));
    expect(first).not.toBe("device-id");
    expect(first).not.toBe(deriveOrgDeviceId("device-id", "org-2"));
  });

  test("keeps credentials per organization in the fallback file", async () => {
    await orgCredentialStore.save("org-1", {
      apiKey: "key-1",
      refreshToken: "refresh-1",
      tokenExpiresAt: 10,
    });
    await orgCredentialStore.save("org-2", { apiKey: "key-2" });

    expect(await orgCredentialStore.load("org-1")).toEqual({
      apiKey: "key-1",
      refreshToken: "refresh-1",
      tokenExpiresAt: 10,
    });
    expect(await orgCredentialStore.load("org-2")).toEqual({ apiKey: "key-2" });
    expect(await orgCredentialStore.load("org-3")).toEqual({});

    const path = join(home, ".letta", "listener-org-auth.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      "org-1": {
        apiKey: "key-1",
        refreshToken: "refresh-1",
        tokenExpiresAt: 10,
      },
      "org-2": { apiKey: "key-2" },
    });
  });

  test("isolates file-backed credentials under the product config root", async () => {
    const configDir = join(home, ".dream");
    const legacyPath = join(home, ".letta", "listener-org-auth.json");
    mkdirSync(join(home, ".letta"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({ "org-1": { apiKey: "legacy" } }),
    );
    process.env.LETTA_CONFIG_DIR = configDir;

    await orgCredentialStore.save("org-1", { apiKey: "dream" });

    expect(await orgCredentialStore.load("org-1")).toEqual({ apiKey: "dream" });
    const isolatedPath = join(configDir, "listener-org-auth.json");
    expect(JSON.parse(readFileSync(isolatedPath, "utf8"))).toEqual({
      "org-1": { apiKey: "dream" },
    });
    expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual({
      "org-1": { apiKey: "legacy" },
    });
    if (process.platform !== "win32") {
      expect(statSync(configDir).mode & 0o777).toBe(0o700);
      expect(statSync(isolatedPath).mode & 0o777).toBe(0o600);
    }
  });
});
