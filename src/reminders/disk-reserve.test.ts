import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskReserve, setDiskReserve } from "@/utils/disk-reserve";
import { checkDiskSpaceNow, resetDiskSpaceAlertForTests } from "./disk-space";

const GIB = 1024 ** 3;
const root = mkdtempSync(join(tmpdir(), "watch-reserve-"));
afterEach(() => {
  resetDiskSpaceAlertForTests();
  rmSync(root, { recursive: true, force: true });
});

test("watcher releases at 95%, alerts once, and recreates only with safe headroom", async () => {
  const path = join(root, "reserve");
  let alerts = 0;
  let available = 10 * GIB;
  setDiskReserve(
    new DiskReserve(
      path,
      () => {
        alerts++;
      },
      4096,
    ),
  );
  const poll = () =>
    checkDiskSpaceNow(tmpdir(), {
      env: { LETTA_MANAGED_CLOUD_RUNTIME: "1" },
      statfsFn: async () => ({ bsize: 1, blocks: 20 * GIB, bavail: available }),
    });
  await poll();
  expect(existsSync(path)).toBe(true);
  available = 1.1 * GIB;
  await poll();
  expect(existsSync(path)).toBe(true);
  available = GIB;
  await poll();
  expect(existsSync(path)).toBe(false);
  await poll();
  expect(alerts).toBe(1);
  available = 2 * GIB;
  await poll();
  expect(existsSync(path)).toBe(false);
  available = 2 * GIB + 4096; // allocation would leave exactly 90% used
  await poll();
  expect(existsSync(path)).toBe(false);
  available = 3 * GIB;
  await poll();
  expect(existsSync(path)).toBe(true);
  available = GIB;
  await poll();
  expect(alerts).toBe(2);
});
