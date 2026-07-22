import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetListenerLockForTests,
  claimListenerLock,
  getListenerLockPath,
  releaseListenerLock,
} from "./instance-lock";

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "listener-lock-"));
  __resetListenerLockForTests();
});

afterEach(() => {
  __resetListenerLockForTests();
  rmSync(lockDir, { recursive: true, force: true });
});

describe("claimListenerLock", () => {
  test("acquires a fresh lock and records this process", async () => {
    const result = await claimListenerLock("li-abc", lockDir);
    expect(result.kind).toBe("acquired");
    if (result.kind !== "acquired") throw new Error("unreachable");
    const record = JSON.parse(readFileSync(result.lockPath, "utf-8"));
    expect(record.pid).toBe(process.pid);
    expect(record.listenerInstanceId).toBe("li-abc");
  });

  test("different instance ids never contend (coexistence is the default)", async () => {
    const a = await claimListenerLock("li-a", lockDir);
    const b = await claimListenerLock("li-b", lockDir);
    expect(a.kind).toBe("acquired");
    expect(b.kind).toBe("acquired");
    expect(getListenerLockPath("li-a", lockDir)).not.toBe(
      getListenerLockPath("li-b", lockDir),
    );
  });

  test("reports 'held' with the live holder — and never kills", async () => {
    // A live foreign pid holds the lock. Use pid 1 (launchd/init): always
    // alive, and if this code EVER tried to signal it the test environment
    // would notice. claimListenerLock has no kill path by design.
    const lockPath = getListenerLockPath("li-held", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 1,
        listenerInstanceId: "li-held",
        acquiredAt: Date.now(),
      }),
    );

    const result = await claimListenerLock("li-held", lockDir);
    expect(result.kind).toBe("held");
    if (result.kind !== "held") throw new Error("unreachable");
    expect(result.holder.pid).toBe(1);
    // Lock file untouched — the incumbent still owns it.
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(1);
  });

  test("reclaims a stale lock from a dead pid", async () => {
    const lockPath = getListenerLockPath("li-stale", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        listenerInstanceId: "li-stale",
        acquiredAt: 1,
      }),
    );

    const result = await claimListenerLock("li-stale", lockDir);
    expect(result.kind).toBe("acquired");
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(process.pid);
  });

  test("reclaims a corrupt lock file", async () => {
    const lockPath = getListenerLockPath("li-corrupt", lockDir);
    writeFileSync(lockPath, "not json");

    const result = await claimListenerLock("li-corrupt", lockDir);
    expect(result.kind).toBe("acquired");
  });

  test("a live same-pid holder is 'held' too (double-start within one process fails visibly)", async () => {
    const lockPath = getListenerLockPath("li-self", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        listenerInstanceId: "li-self",
        acquiredAt: 1,
      }),
    );

    const result = await claimListenerLock("li-self", lockDir);
    expect(result.kind).toBe("held");
  });

  test("acquisition is atomic: concurrent claimants produce exactly one winner", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimListenerLock("li-race", lockDir)),
    );
    const acquired = results.filter((r) => r.kind === "acquired");
    const held = results.filter((r) => r.kind === "held");
    // Exactly one claimant wins the hard-link CAS; every loser observes a
    // live holder and reports "held". Nobody concludes "unlocked" while
    // another claim is mid-write, and nobody reclaims a live lock.
    expect(acquired.length).toBe(1);
    expect(held.length).toBe(7);
    const record = JSON.parse(
      readFileSync(getListenerLockPath("li-race", lockDir), "utf-8"),
    );
    expect(record.pid).toBe(process.pid);
    expect(record.listenerInstanceId).toBe("li-race");
  });

  test("returns 'unavailable' instead of throwing when the lock dir is unusable", async () => {
    const fileAsDir = join(lockDir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    const result = await claimListenerLock("li-x", join(fileAsDir, "sub"));
    expect(result.kind).toBe("unavailable");
  });
});

describe("releaseListenerLock", () => {
  test("removes the lock this session acquired", async () => {
    const result = await claimListenerLock("li-rel", lockDir);
    expect(result.kind).toBe("acquired");
    await releaseListenerLock();
    expect(() =>
      readFileSync(getListenerLockPath("li-rel", lockDir), "utf-8"),
    ).toThrow();
  });

  test("leaves a newer claimant's lock intact", async () => {
    const result = await claimListenerLock("li-newer", lockDir);
    expect(result.kind).toBe("acquired");
    const lockPath = getListenerLockPath("li-newer", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid + 1,
        listenerInstanceId: "li-newer",
        acquiredAt: Date.now(),
      }),
    );
    await releaseListenerLock();
    expect(JSON.parse(readFileSync(lockPath, "utf-8")).pid).toBe(
      process.pid + 1,
    );
  });

  test("is a no-op without a prior claim", async () => {
    await releaseListenerLock();
  });
});
