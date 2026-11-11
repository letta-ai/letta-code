import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "./cron-file";
import {
  claimListenerCronLease,
  clearListenerCronOwner,
  configureListenerCronOwner,
  releaseListenerCronLease,
  verifyListenerCronLease,
} from "./listener-lease";

test("listener leases fence duplicate owners and preserve identity across restarts", () => {
  const home = mkdtempSync(join(tmpdir(), "listener-cron-lease-"));
  const originalHome = process.env.LETTA_HOME;
  process.env.LETTA_HOME = home;
  try {
    const id = configureListenerCronOwner("device", "server");
    const lease = withLock(() => claimListenerCronLease(id));
    expect(() => withLock(() => claimListenerCronLease(id))).toThrow(
      "Listener scheduler lease held",
    );
    withLock(() => releaseListenerCronLease({ ...lease, token: "stale" }));
    expect(verifyListenerCronLease(lease)).toBe(true);
    withLock(() => releaseListenerCronLease(lease));
    clearListenerCronOwner();
    expect(configureListenerCronOwner("device", "server")).toBe(id);
    const restarted = withLock(() => claimListenerCronLease(id));
    expect(restarted.token).not.toBe(lease.token);
    expect(verifyListenerCronLease(lease)).toBe(false);
    expect(configureListenerCronOwner("device", "other-server")).not.toBe(id);
    withLock(() => releaseListenerCronLease(restarted));
  } finally {
    clearListenerCronOwner();
    if (originalHome === undefined) delete process.env.LETTA_HOME;
    else process.env.LETTA_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
