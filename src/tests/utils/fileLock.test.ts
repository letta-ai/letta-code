import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../utils/fileLock";

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
});
