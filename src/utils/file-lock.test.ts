import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryAcquireFileLock, withFileLock } from "@/utils/file-lock";
import { getProcessStartTime } from "@/utils/process-liveness";

describe("withFileLock", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "letta-file-lock-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("releases the lock after the critical section", async () => {
    const lockPath = join(tmpDir, "a.lock");
    await withFileLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  test("serializes concurrent critical sections", async () => {
    const lockPath = join(tmpDir, "a.lock");
    let active = 0;
    let observedMaxActive = 0;
    const order: string[] = [];

    const worker = async (id: string) => {
      await withFileLock(lockPath, async () => {
        active += 1;
        observedMaxActive = Math.max(observedMaxActive, active);
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${id}`);
        active -= 1;
      });
    };

    await Promise.all([worker("a"), worker("b"), worker("c")]);

    expect(observedMaxActive).toBe(1);
    expect(order).toHaveLength(6);
    for (const id of ["a", "b", "c"]) {
      const startIdx = order.indexOf(`start:${id}`);
      const endIdx = order.indexOf(`end:${id}`);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBe(startIdx + 1);
    }
  });

  test("reaps stale lock files older than staleMs", async () => {
    const lockPath = join(tmpDir, "a.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, acquiredAt: Date.now() - 60_000 }),
      "utf-8",
    );

    let entered = false;
    await withFileLock(
      lockPath,
      async () => {
        entered = true;
      },
      { staleMs: 1000, retryMs: 5, timeoutMs: 1000 },
    );

    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reaps corrupt lock files left by crashed acquisitions", async () => {
    const lockPath = join(tmpDir, "a.lock");
    await writeFile(lockPath, "", "utf-8");

    let entered = false;
    await withFileLock(
      lockPath,
      async () => {
        entered = true;
      },
      { staleMs: 60_000, retryMs: 5, timeoutMs: 1000 },
    );

    expect(entered).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("times out when the lock is held and not stale", async () => {
    const lockPath = join(tmpDir, "a.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      "utf-8",
    );

    await expect(
      withFileLock(lockPath, async () => undefined, {
        staleMs: 60_000,
        retryMs: 5,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/File lock timeout/);
  });

  test("releases the lock even when fn throws", async () => {
    const lockPath = join(tmpDir, "a.lock");
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reapOnlyDeadOwner keeps an old lock whose holder is still running", async () => {
    const lockPath = join(tmpDir, "owner.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        started: await getProcessStartTime(process.pid),
        acquiredAt: Date.now() - 10 * 60_000,
      }),
    );
    await expect(
      withFileLock(lockPath, async () => "entered", {
        reapOnlyDeadOwner: true,
        timeoutMs: 200,
      }),
    ).rejects.toThrow("File lock timeout");
  });

  test("reapOnlyDeadOwner reaps a lock whose pid was reused", async () => {
    const lockPath = join(tmpDir, "reused.lock");
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        started: "1970-01-01",
        acquiredAt: Date.now(),
      }),
    );
    expect(
      await withFileLock(lockPath, async () => "entered", {
        reapOnlyDeadOwner: true,
      }),
    ).toBe("entered");
  });

  test("a reaper does not delete a lock that was re-acquired after it judged the old one dead", async () => {
    const lockPath = join(tmpDir, "reacquired.lock");
    // Stale lock: a pid that no longer runs.
    const child = Bun.spawn(
      [process.execPath, "-e", "console.log(process.pid)"],
      { stdout: "pipe" },
    );
    const deadPid = Number(await new Response(child.stdout).text());
    await child.exited;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: deadPid, started: "1970-01-01", acquiredAt: 0 }),
    );
    // A live contender wins the lock between another reaper's read and unlink:
    // simulate by holding the reap marker while the live acquisition happens.
    const reapPath = `${lockPath}.reap`;
    await writeFile(
      reapPath,
      JSON.stringify({
        pid: process.pid,
        started: await getProcessStartTime(process.pid),
        acquiredAt: Date.now(),
      }),
    );
    // While the marker is held, no other reaper may remove the stale lock.
    await expect(
      withFileLock(lockPath, async () => "entered", {
        reapOnlyDeadOwner: true,
        timeoutMs: 300,
      }),
    ).rejects.toThrow("File lock timeout");
    await rm(reapPath, { force: true });
    expect(
      await withFileLock(lockPath, async () => "entered", {
        reapOnlyDeadOwner: true,
      }),
    ).toBe("entered");
    expect(existsSync(reapPath)).toBe(false);
  });

  test("tryAcquireFileLock returns null at once when held and timeoutMs is 0", async () => {
    const lockPath = join(tmpDir, "held.lock");
    const release = await tryAcquireFileLock(lockPath);
    expect(release).not.toBeNull();
    expect(await tryAcquireFileLock(lockPath, { timeoutMs: 0 })).toBeNull();
    await release?.();
    const again = await tryAcquireFileLock(lockPath, { timeoutMs: 0 });
    expect(again).not.toBeNull();
    await again?.();
  });

  test("an abort signal stops an unbounded wait", async () => {
    const lockPath = join(tmpDir, "waiting.lock");
    const release = await tryAcquireFileLock(lockPath);
    const controller = new AbortController();
    const waiting = tryAcquireFileLock(lockPath, {
      timeoutMs: Number.POSITIVE_INFINITY,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(waiting).rejects.toThrow();
    await release?.();
  });

  test("release does not remove a lock that now belongs to someone else", async () => {
    const lockPath = join(tmpDir, "foreign.lock");
    const release = await tryAcquireFileLock(lockPath);
    // Simulate a reaper replacing our lock with another holder's record.
    const foreign = JSON.stringify({
      pid: process.pid,
      acquiredAt: Date.now(),
    });
    await writeFile(lockPath, foreign);
    await release?.();
    expect(existsSync(lockPath)).toBe(true);
    await rm(lockPath);
  });
});
