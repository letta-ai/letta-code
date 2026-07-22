import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isLegacyDesktopSpawn,
  isValidListenerInstanceId,
  LISTENER_INSTANCE_ID_ENV,
  ListenerIdentityUnavailableError,
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
    dependencies?: {
      isPidAlive?: (pid: number) => boolean;
      sleep?: (ms: number) => Promise<void>;
    };
  } = {},
) {
  return resolveListenerIdentity(name, {
    namespace: overrides.namespace ?? "server",
    workingDirectory: overrides.workingDirectory ?? "/proj",
    ...(overrides.dependencies ? { dependencies: overrides.dependencies } : {}),
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

  test("recovers from a corrupt identity file", async () => {
    const before = await resolve("corrupt-env");
    // Locate and corrupt the identity file.
    const files = readdirSync(identityDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    writeFileSync(join(identityDir, files[0] as string), "not json");

    const after = await resolve("corrupt-env");
    expect(after.source).toBe("minted");
    expect(after.listenerInstanceId).not.toBe(before.listenerInstanceId);
    // Stable again afterwards.
    const again = await resolve("corrupt-env");
    expect(again.listenerInstanceId).toBe(after.listenerInstanceId);
  });

  test("TOCTOU regression: a repairer that captured corrupt contents cannot remove a VALID identity republished mid-flight", async () => {
    // Recreates the interleaving from the repair path itself: B reads
    // corrupt C and enters repairCorruptIdentity; A (simulated inside B's
    // claim-owner liveness probe — i.e. after B has captured C but before
    // B's guarded remove) repairs C and publishes valid identity A'. B's
    // content re-verification must observe the change and leave A'
    // untouched; B converges on A'.
    await resolve("toctou-env");
    const files = readdirSync(identityDir).filter((f) => f.endsWith(".json"));
    const identityPath = join(identityDir, files[0] as string);
    const corruptRaw = "corrupt-generation";
    writeFileSync(identityPath, corruptRaw);

    // A holds the repair claim for corrupt generation C (live owner)...
    const claimPath = `${identityPath}.repair-${createHash("sha256")
      .update(corruptRaw)
      .digest("hex")
      .slice(0, 16)}`;
    writeFileSync(claimPath, JSON.stringify({ pid: process.pid }));

    // B resolves. Its first repair attempt finds A's live claim and waits;
    // A "finishes" during B's sleep: removes the corrupt file, publishes
    // valid identity A', releases the claim.
    const validA = JSON.stringify({ listenerInstanceId: "li-valid-from-A" });
    let slept = 0;
    const b = await resolve("toctou-env", {
      dependencies: {
        isPidAlive: () => true, // A's claim owner is alive
        sleep: async () => {
          slept += 1;
          writeFileSync(identityPath, validA);
          rmSync(claimPath, { force: true });
        },
      },
    });
    expect(slept).toBeGreaterThanOrEqual(1);
    expect(b.source).toBe("persisted");
    expect(b.listenerInstanceId).toBe("li-valid-from-A");
    expect(readFileSync(identityPath, "utf-8")).toBe(validA);
  });

  test("SPLIT regression: concurrent resolvers over a corrupt identity converge on ONE identity", async () => {
    // The reviewer's reproduction: contended repair must never fall back
    // to random session identities — that hands racers different lock
    // keys. All concurrent resolvers must settle on a single identity.
    await resolve("split-env");
    const files = readdirSync(identityDir).filter((f) => f.endsWith(".json"));
    const identityPath = join(identityDir, files[0] as string);
    writeFileSync(identityPath, "corrupt-generation");

    const results = await Promise.all(
      Array.from({ length: 6 }, () => resolve("split-env")),
    );
    const ids = new Set(results.map((r) => r.listenerInstanceId));
    expect(ids.size).toBe(1);
    // And the winning identity is the persisted one.
    const persisted = JSON.parse(readFileSync(identityPath, "utf-8")) as {
      listenerInstanceId: string;
    };
    expect(ids.has(persisted.listenerInstanceId)).toBe(true);
  });

  test("recovers a repair claim left by a CRASHED repairer", async () => {
    await resolve("crashed-env");
    const files = readdirSync(identityDir).filter((f) => f.endsWith(".json"));
    const identityPath = join(identityDir, files[0] as string);
    const corruptRaw = "corrupt-generation";
    writeFileSync(identityPath, corruptRaw);

    // A crashed repairer's claim (dead pid) sits on this generation.
    const claimPath = `${identityPath}.repair-${createHash("sha256")
      .update(corruptRaw)
      .digest("hex")
      .slice(0, 16)}`;
    writeFileSync(claimPath, JSON.stringify({ pid: 999999 }));

    const identity = await resolve("crashed-env", {
      dependencies: { isPidAlive: (pid: number) => pid === process.pid },
    });
    expect(identity.source).toBe("minted");
    // Repaired and re-minted; stable afterwards.
    const again = await resolve("crashed-env");
    expect(again.listenerInstanceId).toBe(identity.listenerInstanceId);
  });

  test("fails VISIBLY (never a random identity) when a live repairer never finishes", async () => {
    await resolve("wedged-env");
    const files = readdirSync(identityDir).filter((f) => f.endsWith(".json"));
    const identityPath = join(identityDir, files[0] as string);
    const corruptRaw = "corrupt-generation";
    writeFileSync(identityPath, corruptRaw);
    const claimPath = `${identityPath}.repair-${createHash("sha256")
      .update(corruptRaw)
      .digest("hex")
      .slice(0, 16)}`;
    writeFileSync(claimPath, JSON.stringify({ pid: process.pid }));

    // The claim owner stays alive and the corrupt file never changes:
    // resolution must throw, not silently mint a session identity.
    await expect(
      resolve("wedged-env", {
        dependencies: {
          isPidAlive: () => true,
          sleep: async () => {},
        },
      }),
    ).rejects.toBeInstanceOf(ListenerIdentityUnavailableError);
    // The corrupt generation and A's claim are both untouched.
    expect(readFileSync(identityPath, "utf-8")).toBe(corruptRaw);
    expect(readFileSync(claimPath, "utf-8")).toContain(String(process.pid));
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
