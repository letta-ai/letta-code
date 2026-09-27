import { afterEach, describe, expect, test } from "bun:test";
import {
  DISK_SPACE_CHECK_INTERVAL_MS,
  evaluateDiskSpaceReminder,
  getCachedDiskSpaceSample,
  isDiskSpaceLow,
  refreshDiskSpaceSample,
  resetDiskSpaceCacheForTests,
} from "@/reminders/disk-space";

const GIB = 1024 ** 3;
const SANDBOX_ENV = { LETTA_MANAGED_CLOUD_RUNTIME: "1" };

function fakeStatfs(totalBytes: number, availableBytes: number) {
  const calls: string[] = [];
  const fn = async (path: string) => {
    calls.push(path);
    return {
      bsize: 1024,
      blocks: totalBytes / 1024,
      bavail: availableBytes / 1024,
    };
  };
  return { fn, calls };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  resetDiskSpaceCacheForTests();
});

describe("isDiskSpaceLow", () => {
  test("low at 90% used", () => {
    expect(
      isDiskSpaceLow({
        path: "/",
        totalBytes: 100 * GIB,
        availableBytes: 10 * GIB,
      }),
    ).toBe(true);
  });

  test("low under 1 GiB free even below 90% used", () => {
    // 5 GiB volume, 0.8 GiB free = 84% used, but under the 1 GiB floor.
    expect(
      isDiskSpaceLow({
        path: "/",
        totalBytes: 5 * GIB,
        availableBytes: 0.8 * GIB,
      }),
    ).toBe(true);
  });

  test("not low with room to spare", () => {
    expect(
      isDiskSpaceLow({
        path: "/",
        totalBytes: 20 * GIB,
        availableBytes: 15 * GIB,
      }),
    ).toBe(false);
  });

  test("zero-size volume is never low", () => {
    expect(
      isDiskSpaceLow({ path: "/", totalBytes: 0, availableBytes: 0 }),
    ).toBe(false);
  });
});

describe("evaluateDiskSpaceReminder", () => {
  test("does nothing outside managed Cloud sandboxes", () => {
    const statfs = fakeStatfs(20 * GIB, 0.1 * GIB);
    const result = evaluateDiskSpaceReminder({
      workingDirectory: "/root",
      notified: false,
      env: {},
      statfsFn: statfs.fn,
    });
    expect(result.text).toBeNull();
    expect(statfs.calls).toEqual([]);
  });

  test("first turn does not wait on the filesystem; the next turn reports", async () => {
    const statfs = fakeStatfs(20 * GIB, 0.5 * GIB);
    const first = evaluateDiskSpaceReminder({
      workingDirectory: "/root/workspace",
      notified: false,
      env: SANDBOX_ENV,
      nowMs: 0,
      statfsFn: statfs.fn,
    });
    expect(first.text).toBeNull();
    expect(statfs.calls).toEqual(["/root/workspace"]);

    await flush();
    const second = evaluateDiskSpaceReminder({
      workingDirectory: "/root/workspace",
      notified: first.notified,
      env: SANDBOX_ENV,
      nowMs: 1_000,
      statfsFn: statfs.fn,
    });
    expect(second.text).toContain("LOW DISK SPACE");
    expect(second.text).toContain("/root/workspace");
    expect(second.text).toContain("512 MB available");
    expect(second.notified).toBe(true);
    // Throttled: the second turn inside the interval did not re-measure.
    expect(statfs.calls).toHaveLength(1);
  });

  test("reports once per episode and re-arms after recovery", async () => {
    let available = 0.5 * GIB;
    const fn = async () => ({
      bsize: 1024,
      blocks: (20 * GIB) / 1024,
      bavail: available / 1024,
    });
    const run = (notified: boolean, nowMs: number) =>
      evaluateDiskSpaceReminder({
        workingDirectory: "/root",
        notified,
        env: SANDBOX_ENV,
        nowMs,
        statfsFn: fn,
      });

    let state = run(false, 0);
    await flush();
    state = run(state.notified, 1);
    expect(state.text).not.toBeNull();

    state = run(state.notified, 2);
    expect(state.text).toBeNull();
    expect(state.notified).toBe(true);

    available = 10 * GIB;
    state = run(state.notified, DISK_SPACE_CHECK_INTERVAL_MS + 2);
    await flush();
    state = run(state.notified, DISK_SPACE_CHECK_INTERVAL_MS + 3);
    expect(state.text).toBeNull();
    expect(state.notified).toBe(false);

    available = 0.2 * GIB;
    state = run(state.notified, 2 * DISK_SPACE_CHECK_INTERVAL_MS + 3);
    await flush();
    state = run(state.notified, 2 * DISK_SPACE_CHECK_INTERVAL_MS + 4);
    expect(state.text).toContain("LOW DISK SPACE");
  });

  test("statfs rejection and synchronous throw are silent", async () => {
    const rejecting = async () => {
      throw new Error("EACCES");
    };
    const result = evaluateDiskSpaceReminder({
      workingDirectory: "/root",
      notified: false,
      env: SANDBOX_ENV,
      nowMs: 0,
      statfsFn: rejecting,
    });
    expect(result.text).toBeNull();
    await flush();
    expect(getCachedDiskSpaceSample()).toBeNull();

    const throwing = (() => {
      throw new Error("boom");
    }) as unknown as typeof rejecting;
    refreshDiskSpaceSample("/root", {
      nowMs: DISK_SPACE_CHECK_INTERVAL_MS,
      statfsFn: throwing,
    });
    expect(getCachedDiskSpaceSample()).toBeNull();
  });

  test("measures the real volume without throwing", async () => {
    refreshDiskSpaceSample(process.cwd());
    for (let i = 0; i < 20 && !getCachedDiskSpaceSample(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const sample = getCachedDiskSpaceSample();
    expect(sample?.totalBytes).toBeGreaterThan(0);
  });
});
