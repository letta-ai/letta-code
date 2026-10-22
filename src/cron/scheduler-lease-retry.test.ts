import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CronTask, readCronFile } from "@/cron/cron-file";
import {
  isSchedulerRunning,
  startScheduler,
  stopScheduler,
} from "@/cron/scheduler";
import type { ListenerTransport } from "@/websocket/listener/transport";

const TEST_DIR = path.join(import.meta.dir, "__scheduler_lease_retry_tmp__");
const origHome = process.env.LETTA_HOME;
const origSandboxId = process.env.LETTA_MANAGED_CLOUD_RUNTIME;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
});

afterEach(() => {
  stopScheduler();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (origHome) process.env.LETTA_HOME = origHome;
  else delete process.env.LETTA_HOME;
  if (origSandboxId) process.env.LETTA_MANAGED_CLOUD_RUNTIME = origSandboxId;
});

test("slow lease retry claims the scheduler once the lease frees", () => {
  const cronPath = path.join(TEST_DIR, "crons.json");
  writeFileSync(
    cronPath,
    JSON.stringify({
      version: 1,
      scheduler_owner: {
        pid: process.ppid,
        token: "held-by-another-process",
        started_at: new Date().toISOString(),
      },
      tasks: [] satisfies CronTask[],
    }),
  );
  const slowRetries: Array<() => void> = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((
    fn: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    if (ms === 5 * 60_000) slowRetries.push(fn);
    return realSetInterval(fn, ms, ...rest);
  }) as typeof setInterval;

  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-slow-retry",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-slow-retry",
        connectionName: "listener-slow-retry",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
      3,
    );
    expect(slowRetries).toHaveLength(1);
    expect(isSchedulerRunning()).toBe(false);

    // Still held: retry stays silent.
    slowRetries[0]?.();
    expect(isSchedulerRunning()).toBe(false);
    expect(logged).toHaveLength(2);

    // Lease frees: next slow retry claims it and logs once.
    writeFileSync(
      cronPath,
      JSON.stringify({ version: 1, scheduler_owner: null, tasks: [] }),
    );
    slowRetries[0]?.();
    expect(isSchedulerRunning()).toBe(true);
    expect(readCronFile().scheduler_owner?.pid).toBe(process.pid);
    expect(
      logged.filter((line) => line.includes("Claimed scheduler lease")),
    ).toHaveLength(1);
  } finally {
    globalThis.setInterval = realSetInterval;
  }
});
