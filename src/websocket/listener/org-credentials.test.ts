import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveOrgDeviceId,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";

describe("organization listener credentials", () => {
  const originalHome = process.env.HOME;
  const originalSkipKeychain = process.env.LETTA_SKIP_KEYCHAIN_CHECK;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "letta-org-credentials-"));
    process.env.HOME = home;
    process.env.LETTA_SKIP_KEYCHAIN_CHECK = "1";
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalSkipKeychain === undefined) {
      delete process.env.LETTA_SKIP_KEYCHAIN_CHECK;
    } else {
      process.env.LETTA_SKIP_KEYCHAIN_CHECK = originalSkipKeychain;
    }
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
});
