import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLegacyDesktopSpawn,
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
  resolveListenerIdentity,
} from "./identity";

const originalInstanceEnv = process.env[LISTENER_INSTANCE_ID_ENV];
const originalDesktopMode = process.env.LETTA_DESKTOP_MODE;

let identityDir: string;

beforeEach(() => {
  delete process.env[LISTENER_INSTANCE_ID_ENV];
  delete process.env.LETTA_DESKTOP_MODE;
  identityDir = mkdtempSync(join(tmpdir(), "listener-identity-"));
});

afterEach(() => {
  if (originalInstanceEnv === undefined) {
    delete process.env[LISTENER_INSTANCE_ID_ENV];
  } else {
    process.env[LISTENER_INSTANCE_ID_ENV] = originalInstanceEnv;
  }
  if (originalDesktopMode === undefined) {
    delete process.env.LETTA_DESKTOP_MODE;
  } else {
    process.env.LETTA_DESKTOP_MODE = originalDesktopMode;
  }
  rmSync(identityDir, { recursive: true, force: true });
});

function resolve(
  name: string,
  overrides: {
    namespace?: "server" | "listen";
    workingDirectory?: string;
  } = {},
) {
  return resolveListenerIdentity(name, {
    namespace: overrides.namespace ?? "server",
    workingDirectory: overrides.workingDirectory ?? "/proj",
    identityDir,
  });
}

describe("resolveListenerIdentity", () => {
  test("mints and persists a UUID identity on first run", async () => {
    const identity = await resolve("MacBook-Pro-8.local");
    expect(identity.source).toBe("minted");
    expect(identity.listenerInstanceId).toMatch(/^li-/);
  });

  test("returns the persisted identity on subsequent runs (stable across restarts)", async () => {
    const first = await resolve("Developers");
    const second = await resolve("Developers");
    expect(second.source).toBe("persisted");
    expect(second.listenerInstanceId).toBe(first.listenerInstanceId);
  });

  test("identity get-or-create is atomic: concurrent first-time resolvers converge on ONE identity", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolve("raced-env")),
    );
    const ids = new Set(results.map((r) => r.listenerInstanceId));
    expect(ids.size).toBe(1);
    // No candidate litter left behind.
    const leftovers = readdirSync(identityDir).filter((f) =>
      f.includes("candidate"),
    );
    expect(leftovers).toEqual([]);
  });

  test("distinct configurations get independent identities (namespace, name, project)", async () => {
    const base = await resolve("shared-name");
    const otherNamespace = await resolve("shared-name", {
      namespace: "listen",
    });
    const otherName = await resolve("other-name");
    const otherProject = await resolve("shared-name", {
      workingDirectory: "/other-proj",
    });
    const ids = new Set([
      base.listenerInstanceId,
      otherNamespace.listenerInstanceId,
      otherName.listenerInstanceId,
      otherProject.listenerInstanceId,
    ]);
    expect(ids.size).toBe(4);
  });

  test("identity VALUE is random, never name-derived: same configuration on a fresh store differs", async () => {
    const first = await resolve("Developers");
    rmSync(identityDir, { recursive: true, force: true });
    const second = await resolve("Developers");
    expect(second.source).toBe("minted");
    expect(second.listenerInstanceId).not.toBe(first.listenerInstanceId);
  });

  test("spawner-provided identity wins and is never persisted", async () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";
    const identity = await resolve("host");
    expect(identity.source).toBe("spawner");
    expect(identity.listenerInstanceId).toBe("desktop-primary:install-42");
    expect(readdirSync(identityDir)).toEqual([]);
  });

  test("an invalid spawner value falls through to the persisted/minted path", async () => {
    process.env[LISTENER_INSTANCE_ID_ENV] = "bad value with spaces!";
    const identity = await resolve("host");
    expect(identity.source).toBe("minted");
  });
});

describe("isLegacyDesktopSpawn", () => {
  test("true for desktop mode without an explicit identity", () => {
    process.env.LETTA_DESKTOP_MODE = "1";
    expect(isLegacyDesktopSpawn()).toBe(true);
  });

  test("false when the spawner provides an identity", () => {
    process.env.LETTA_DESKTOP_MODE = "1";
    process.env[LISTENER_INSTANCE_ID_ENV] = "desktop-primary:install-42";
    expect(isLegacyDesktopSpawn()).toBe(false);
  });

  test("false outside desktop mode", () => {
    expect(isLegacyDesktopSpawn()).toBe(false);
  });
});

describe("isValidListenerInstanceId", () => {
  test("accepts minted, desktop-slot, and legacy-derived shapes", () => {
    expect(isValidListenerInstanceId("li-3f9a2b1c-aaaa-bbbb")).toBe(true);
    expect(isValidListenerInstanceId("desktop-primary:install-42")).toBe(true);
    expect(isValidListenerInstanceId("server-0123456789abcdef")).toBe(true);
  });

  test("rejects empty, oversized, and unsafe values", () => {
    expect(isValidListenerInstanceId("")).toBe(false);
    expect(isValidListenerInstanceId("has spaces")).toBe(false);
    expect(isValidListenerInstanceId(`x${"a".repeat(200)}`)).toBe(false);
    expect(isValidListenerInstanceId("-leading-dash")).toBe(false);
  });
});
