import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exclusivePublishOps } from "@/utils/exclusive-publish";
import {
  acquireDurableFileLock,
  type DurableLockOwner,
} from "@/websocket/listener/durable-file-lock";
import {
  acquireManualListenerLock,
  ManualListenerAlreadyRunningError,
  ManualListenerLockUnavailableError,
} from "@/websocket/listener/manual-instance-lock";
import {
  releaseRemoteSettingsLock,
  releaseRemoteSettingsLockSync,
  tryAcquireRemoteSettingsLock,
  tryAcquireRemoteSettingsLockSync,
} from "@/websocket/listener/remote-settings-lock";

// Every lock here must work on a volume where CreateHardLink fails with
// ERROR_INVALID_FUNCTION, which Node reports on Windows as EISDIR.
const originalOps = { ...exclusivePublishOps };
const DEAD_PID = 2_147_483_647;

let root: string;
let linkCalls = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "letta-no-hardlinks-"));
  linkCalls = 0;
  const unsupported = () => {
    linkCalls++;
    throw Object.assign(new Error("EISDIR: illegal operation, link"), {
      code: "EISDIR",
    });
  };
  exclusivePublishOps.platform = () => "win32";
  exclusivePublishOps.link = async () => unsupported();
  exclusivePublishOps.linkSync = unsupported;
});

afterEach(() => {
  Object.assign(exclusivePublishOps, originalOps);
  rmSync(root, { recursive: true, force: true });
});

function age(path: string): void {
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
}

describe("durable file lock without hard links", () => {
  const owner = (token: string, pid = process.pid): DurableLockOwner => ({
    token,
    pid,
    processStart: null,
  });

  test("acquires, excludes a second contender, and releases", () => {
    const path = join(root, "state.json");
    const release = acquireDurableFileLock(path, {
      owner: owner("first"),
      isOwnerAlive: () => true,
    });
    expect(linkCalls).toBeGreaterThan(0);
    expect(readdirSync(`${path}.lock`)).toEqual([`${process.pid}-first.json`]);

    expect(() =>
      acquireDurableFileLock(path, {
        owner: owner("second"),
        isOwnerAlive: () => true,
        waitMs: 20,
      }),
    ).toThrow(/Timed out/);
    expect(readdirSync(`${path}.lock`)).toEqual([`${process.pid}-first.json`]);

    release();
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  test("takes over a dead owner", () => {
    const path = join(root, "state.json");
    const lock = `${path}.lock`;
    const dead = owner("dead", DEAD_PID);
    mkdirSync(lock);
    writeFileSync(join(lock, `${DEAD_PID}-dead.json`), JSON.stringify(dead));

    const release = acquireDurableFileLock(path, {
      owner: owner("next"),
      isOwnerAlive: (candidate) => candidate.pid !== DEAD_PID,
      waitMs: 500,
    });
    expect(readdirSync(lock)).toEqual([`${process.pid}-next.json`]);
    release();
  });

  test("a half-written installer is waited on, not reaped or rejected", () => {
    const path = join(root, "state.json");
    const lock = `${path}.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, ".installing"), '{"token":"inst');

    expect(() =>
      acquireDurableFileLock(path, {
        owner: owner("waiter"),
        isOwnerAlive: () => false,
        waitMs: 20,
      }),
    ).toThrow(/Timed out/);
    expect(readFileSync(join(lock, ".installing"), "utf-8")).toBe(
      '{"token":"inst',
    );

    // An old unparsable installer is corruption and still fails closed.
    age(join(lock, ".installing"));
    expect(() =>
      acquireDurableFileLock(path, {
        owner: owner("waiter2"),
        isOwnerAlive: () => false,
        waitMs: 20,
      }),
    ).toThrow(/JSON|Invalid|Unexpected|parse/i);
    expect(existsSync(join(lock, ".installing"))).toBe(true);
  });
});

describe("manual listener lock without hard links", () => {
  const scope = {
    serverUrl: "https://api.letta.com",
    deviceId: "device-1",
    listenerInstanceId: "instance-1",
  };

  test("acquires, blocks a live contender, and recovers a dead owner", async () => {
    const alive = new Set<number>([111]);
    const deps = (processId: number) => ({
      lockRoot: root,
      processId,
      isProcessAlive: (pid: number) => alive.has(pid),
    });

    const first = await acquireManualListenerLock(scope, deps(111));
    expect(linkCalls).toBeGreaterThan(0);
    await expect(acquireManualListenerLock(scope, deps(222))).rejects.toThrow(
      ManualListenerAlreadyRunningError,
    );

    alive.delete(111);
    const second = await acquireManualListenerLock(scope, deps(222));
    expect(JSON.parse(readFileSync(second.lockPath, "utf-8")).pid).toBe(222);
    await first.release();
    expect(existsSync(second.lockPath)).toBe(true);
    await second.release();
    expect(existsSync(second.lockPath)).toBe(false);
  });

  test("a fresh half-written record is treated as still being written", async () => {
    const first = await acquireManualListenerLock(scope, {
      lockRoot: root,
      processId: 111,
    });
    await first.release();
    writeFileSync(first.lockPath, '{"version":1,"pid":');

    await expect(
      acquireManualListenerLock(scope, {
        lockRoot: root,
        processId: 222,
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow(ManualListenerLockUnavailableError);
    expect(readFileSync(first.lockPath, "utf-8")).toBe('{"version":1,"pid":');
  });

  test("an aged half-written record is reaped through the recovery claim", async () => {
    const first = await acquireManualListenerLock(scope, {
      lockRoot: root,
      processId: 111,
    });
    await first.release();

    for (const partial of ['{"version":1,"pid":', ""]) {
      writeFileSync(first.lockPath, partial);
      age(first.lockPath);

      const next = await acquireManualListenerLock(scope, {
        lockRoot: root,
        processId: 222,
        isProcessAlive: () => false,
      });
      expect(JSON.parse(readFileSync(next.lockPath, "utf-8")).pid).toBe(222);
      // Recovery claims are cleaned up after the reap.
      expect(
        readdirSync(join(root, "listeners")).filter((name) =>
          name.includes(".recover."),
        ),
      ).toEqual([]);
      await next.release();
    }
  });

  test("an aged half-written record has exactly one recoverer", async () => {
    const first = await acquireManualListenerLock(scope, {
      lockRoot: root,
      processId: 111,
    });
    await first.release();
    writeFileSync(first.lockPath, '{"version":1,"pid":');
    age(first.lockPath);

    const claims = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        acquireManualListenerLock(scope, {
          lockRoot: root,
          processId: 300 + index,
          isProcessAlive: (pid) => pid >= 300,
        }),
      ),
    );
    const winners = claims.filter((claim) => claim.status === "fulfilled");
    expect(winners).toHaveLength(1);
    if (winners[0]?.status === "fulfilled") await winners[0].value.release();
  });

  test("a valid record from an incompatible version still fails closed", async () => {
    const first = await acquireManualListenerLock(scope, {
      lockRoot: root,
      processId: 111,
    });
    await first.release();
    const foreign = JSON.stringify({
      version: 2,
      pid: 111,
      ownerToken: "owner-from-a-newer-release",
      acquiredAt: new Date(0).toISOString(),
    });
    writeFileSync(first.lockPath, foreign);
    age(first.lockPath);

    await expect(
      acquireManualListenerLock(scope, {
        lockRoot: root,
        processId: 222,
        isProcessAlive: () => false,
      }),
    ).rejects.toThrow(/incompatible version/);
    expect(readFileSync(first.lockPath, "utf-8")).toBe(foreign);
  });
});

describe("remote settings lock without hard links", () => {
  test("sync and async acquisition work and stay exclusive", async () => {
    const lockPath = join(root, "remote-settings.json.lock");
    const handle = tryAcquireRemoteSettingsLockSync(lockPath);
    expect(handle).not.toBeNull();
    expect(linkCalls).toBeGreaterThan(0);
    if (!handle) return;
    expect(readFileSync(lockPath, "utf-8")).toBe(handle.ownerToken);
    releaseRemoteSettingsLockSync(handle);

    // A live foreign owner blocks acquisition.
    writeFileSync(lockPath, `${process.pid}-foreign`);
    expect(tryAcquireRemoteSettingsLockSync(lockPath)).toBeNull();
    expect(await tryAcquireRemoteSettingsLock(lockPath)).toBeNull();
    rmSync(lockPath);

    const asyncHandle = await tryAcquireRemoteSettingsLock(lockPath);
    expect(asyncHandle).not.toBeNull();
    if (asyncHandle) await releaseRemoteSettingsLock(asyncHandle);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a dead owner is taken over", async () => {
    const lockPath = join(root, "remote-settings.json.lock");
    writeFileSync(lockPath, `${DEAD_PID}-dead-owner`);
    const handle = await tryAcquireRemoteSettingsLock(lockPath);
    expect(handle).not.toBeNull();
    if (handle) await releaseRemoteSettingsLock(handle);
  });

  test("a half-written token is not reaped until it is old", () => {
    const lockPath = join(root, "remote-settings.json.lock");
    // A truncated pid: the separator has not been written yet.
    writeFileSync(lockPath, String(DEAD_PID));
    expect(tryAcquireRemoteSettingsLockSync(lockPath)).toBeNull();
    expect(readFileSync(lockPath, "utf-8")).toBe(String(DEAD_PID));

    age(lockPath);
    const handle = tryAcquireRemoteSettingsLockSync(lockPath);
    expect(handle).not.toBeNull();
    if (handle) releaseRemoteSettingsLockSync(handle);
  });
});
