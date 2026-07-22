import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetListenerInstanceLockForTests,
  claimListenerInstanceLock,
  commandLooksLikeLettaProcess,
  getListenerInstanceLockPath,
  releaseListenerInstanceLockSync,
} from "./instance-lock";

let lockDir: string;

beforeEach(() => {
  lockDir = mkdtempSync(join(tmpdir(), "listener-instance-lock-"));
  __resetListenerInstanceLockForTests();
});

afterEach(() => {
  __resetListenerInstanceLockForTests();
  rmSync(lockDir, { recursive: true, force: true });
});

function readRecord(lockPath: string): {
  pid: number;
  deviceId: string;
  connectionName: string;
} {
  return JSON.parse(readFileSync(lockPath, "utf-8"));
}

describe("getListenerInstanceLockPath", () => {
  test("is deterministic per (deviceId, connectionName) scope", () => {
    const a = getListenerInstanceLockPath("dev-1", "MacBook Pro", lockDir);
    const b = getListenerInstanceLockPath("dev-1", "MacBook Pro", lockDir);
    const other = getListenerInstanceLockPath("dev-1", "Other Env", lockDir);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  test("distinguishes device scopes with identical names", () => {
    const a = getListenerInstanceLockPath("dev-1", "Developers", lockDir);
    const b = getListenerInstanceLockPath("dev-2", "Developers", lockDir);
    expect(a).not.toBe(b);
  });

  test("slugs unfriendly environment names", () => {
    const p = getListenerInstanceLockPath(
      "dev-1",
      "MacBook-Pro-8.local (Local Backend)",
      lockDir,
    );
    expect(p).toContain("macbook-pro-8-local-local-backend-");
    expect(p.endsWith(".lock")).toBe(true);
  });
});

describe("commandLooksLikeLettaProcess", () => {
  test("matches production and dev listener command lines", () => {
    expect(
      commandLooksLikeLettaProcess(
        "/Applications/Letta.app/Contents/MacOS/Letta /Applications/Letta.app/Contents/Resources/app.asar.unpacked/node_modules/@letta-ai/letta-code/letta.js remote --env-name MacBook-Pro-8.local",
      ),
    ).toBe(true);
    expect(commandLooksLikeLettaProcess("letta server --channels slack")).toBe(
      true,
    );
    expect(
      commandLooksLikeLettaProcess("node /usr/local/bin/letta.js remote"),
    ).toBe(true);
  });

  test("rejects unrelated programs on a recycled pid", () => {
    expect(commandLooksLikeLettaProcess("/usr/sbin/nginx -g daemon off")).toBe(
      false,
    );
    expect(commandLooksLikeLettaProcess("node server.js")).toBe(false);
  });
});

describe("claimListenerInstanceLock", () => {
  test("claims a fresh scope without reaping", async () => {
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
    });
    expect(result.reapedPid).toBeNull();
    const record = readRecord(result.handle.lockPath);
    expect(record.pid).toBe(process.pid);
    expect(record.deviceId).toBe("dev-1");
    expect(record.connectionName).toBe("Env");
  });

  test("reclaims a lock from a dead pid without terminating", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999999,
        processStartedAt: 1,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 1,
      }),
    );
    const terminated: number[] = [];
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        isProcessAlive: () => false,
        terminateProcess: (pid) => {
          terminated.push(pid);
        },
      },
    });
    expect(terminated).toEqual([]);
    expect(result.reapedPid).toBeNull();
    expect(result.notes.join("\n")).toContain("stale listener lock");
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid);
  });

  test("SIGTERMs a live identity-verified previous holder (newest wins)", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 4242,
        processStartedAt: 1,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 1,
      }),
    );
    const signals: Array<{ pid: number; signal: string }> = [];
    let alive = true;
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        isProcessAlive: () => alive,
        getProcessCommand: () => "letta.js remote --env-name Env",
        terminateProcess: (pid, signal) => {
          signals.push({ pid, signal });
          if (signal === "SIGTERM") {
            alive = false;
          }
        },
      },
    });
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(result.reapedPid).toBe(4242);
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid);
  });

  test("escalates to SIGKILL when the holder ignores SIGTERM", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 4242,
        processStartedAt: 1,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 1,
      }),
    );
    const signals: string[] = [];
    let alive = true;
    // Fake clock: every now() call advances well past both reap windows so
    // waitForProcessExit deadlines expire immediately without real sleeps.
    let fakeNow = 0;
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        isProcessAlive: () => alive,
        getProcessCommand: () => "letta server --channels slack",
        terminateProcess: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            alive = false;
          }
        },
        now: () => {
          fakeNow += 10_000;
          return fakeNow;
        },
      },
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.reapedPid).toBe(4242);
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid);
  });

  test("never terminates when process identity is unverifiable", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 4242,
        processStartedAt: 1,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 1,
      }),
    );
    const terminated: number[] = [];
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        isProcessAlive: () => true,
        getProcessCommand: () => null,
        terminateProcess: (pid) => {
          terminated.push(pid);
        },
      },
    });
    expect(terminated).toEqual([]);
    expect(result.reapedPid).toBeNull();
    expect(result.notes.join("\n")).toContain("unverifiable");
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid);
  });

  test("never terminates a recycled pid owned by another program", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 4242,
        processStartedAt: 1,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 1,
      }),
    );
    const terminated: number[] = [];
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        isProcessAlive: () => true,
        getProcessCommand: () => "/usr/sbin/nginx -g daemon off",
        terminateProcess: (pid) => {
          terminated.push(pid);
        },
      },
    });
    expect(terminated).toEqual([]);
    expect(result.reapedPid).toBeNull();
    expect(result.notes.join("\n")).toContain("recycled");
  });

  test("treats a corrupt lock file as claimable", async () => {
    const lockPath = getListenerInstanceLockPath("dev-1", "Env", lockDir);
    writeFileSync(lockPath, "not json");
    const terminated: number[] = [];
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        terminateProcess: (pid) => {
          terminated.push(pid);
        },
      },
    });
    expect(terminated).toEqual([]);
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid);
  });

  test("re-claim by the same process is a no-op overwrite", async () => {
    const first = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        terminateProcess: () => {
          throw new Error("must not terminate self");
        },
      },
    });
    const second = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
      dependencies: {
        terminateProcess: () => {
          throw new Error("must not terminate self");
        },
      },
    });
    expect(second.reapedPid).toBeNull();
    expect(second.handle.lockPath).toBe(first.handle.lockPath);
  });
});

describe("releaseListenerInstanceLockSync", () => {
  test("removes the lock file it owns", async () => {
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
    });
    releaseListenerInstanceLockSync();
    expect(() => readFileSync(result.handle.lockPath, "utf-8")).toThrow();
  });

  test("leaves a newer claimant's lock file intact", async () => {
    const result = await claimListenerInstanceLock({
      deviceId: "dev-1",
      connectionName: "Env",
      lockDir,
    });
    // Simulate a newer process overwriting the lock after this one lost it.
    writeFileSync(
      result.handle.lockPath,
      JSON.stringify({
        pid: process.pid + 1,
        processStartedAt: 2,
        deviceId: "dev-1",
        connectionName: "Env",
        claimedAt: 2,
      }),
    );
    releaseListenerInstanceLockSync();
    expect(readRecord(result.handle.lockPath).pid).toBe(process.pid + 1);
  });

  test("is a safe no-op without a prior claim", () => {
    expect(() => releaseListenerInstanceLockSync()).not.toThrow();
  });
});
