import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiskReserve,
  setDiskReserve,
  withDiskReserveRetry,
} from "./disk-reserve";

const root = mkdtempSync(join(tmpdir(), "disk-reserve-"));
afterEach(() => {
  setDiskReserve(null);
  rmSync(root, { recursive: true, force: true });
});

test("allocates real blocks and releases once even if notification fails", () => {
  let notifications = 0;
  const path = join(root, "reserve");
  const reserve = new DiskReserve(
    path,
    () => {
      notifications++;
      throw new Error("offline");
    },
    4096,
  );
  reserve.update({
    path: tmpdir(),
    totalBytes: 20 * 1024 ** 3,
    availableBytes: 10 * 1024 ** 3,
  });
  expect(statSync(path).blocks * 512).toBeGreaterThanOrEqual(4096);
  expect(reserve.release(tmpdir())).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(reserve.release(tmpdir())).toBe(false);
  expect(notifications).toBe(1);
});

test("outside managed Cloud an ENOSPC is propagated without releasing", () => {
  const old = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  process.env.LETTA_MANAGED_CLOUD_RUNTIME = "0";
  try {
    const error = Object.assign(new Error("full"), { code: "ENOSPC" });
    let attempts = 0;
    expect(() =>
      withDiskReserveRetry(root, () => {
        attempts++;
        throw error;
      }),
    ).toThrow(error);
    expect(attempts).toBe(1);
  } finally {
    if (old === undefined) delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
    else process.env.LETTA_MANAGED_CLOUD_RUNTIME = old;
  }
});
