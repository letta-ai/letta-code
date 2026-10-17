import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ListenerTransport } from "@/websocket/listener/transport";
import { addTask, getTask, recordTaskQueued, updateTask } from "./cron-file";
import { getCronRunLogPath, readCronRunLogEntries } from "./run-log";
import {
  getIntendedCronOccurrence,
  handleTaskPreflight,
  shouldFireTask,
  startScheduler,
  stopScheduler,
} from "./scheduler";

const originalSandbox = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
const originalHome = process.env.LETTA_HOME;
const dir = mkdtempSync(path.join(tmpdir(), "cron-catch-up-"));
beforeEach(() => {
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  process.env.LETTA_HOME = dir;
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  if (originalSandbox === undefined)
    delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  else process.env.LETTA_MANAGED_CLOUD_RUNTIME = originalSandbox;
  if (originalHome === undefined) delete process.env.LETTA_HOME;
  else process.env.LETTA_HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

test("recurring gaps catch up within grace and record older occurrences once", () => {
  const { task } = addTask({
    agent_id: "agent-test",
    conversation_id: "default",
    name: "daily",
    description: "daily",
    prompt: "hello",
    cron: "0 9 * * *",
    recurring: true,
    timezone: "America/New_York",
  });
  updateTask(task.id, (t) => {
    t.created_at = "2026-06-01T00:00:00.000Z";
  });
  let fresh = getTask(task.id)!;
  const now = new Date("2026-06-03T13:02:00.000Z");
  expect(handleTaskPreflight(fresh, now)).toBe(false);
  expect(shouldFireTask(fresh, now)).toBe(true);
  expect(getIntendedCronOccurrence(fresh, now).toISOString()).toBe(
    "2026-06-03T13:00:00.000Z",
  );
  recordTaskQueued(task.id, "automatic", now);
  fresh = getTask(task.id)!;
  expect(shouldFireTask(fresh, now)).toBe(false);
  expect(shouldFireTask(fresh, new Date("2026-06-03T13:03:00Z"))).toBe(false);

  const late = new Date("2026-06-06T13:06:00.000Z");
  expect(handleTaskPreflight(fresh, late)).toBe(true);
  fresh = getTask(task.id)!;
  expect(fresh.missed_count).toBe(1);
  expect(fresh.last_missed_at).toBe("2026-06-06T13:00:00.000Z");
  expect(fresh.last_run_reason).toBe("scheduler_inactive");
  expect(handleTaskPreflight(fresh, late)).toBe(false);
  expect(shouldFireTask(fresh, late)).toBe(false);
  expect(getTask(task.id)?.fire_count).toBe(1);
  const entries = readCronRunLogEntries(getCronRunLogPath(task.id));
  expect(entries.filter((entry) => entry.outcome === "missed")).toHaveLength(1);
});

test("initial tick catches a two-minute gap and deduplicates pending jitter across ticks", () => {
  const now = new Date();
  const occurrence = new Date(now);
  occurrence.setMinutes(occurrence.getMinutes() - 2, 0, 0);
  const { task } = addTask({
    agent_id: "agent-test",
    conversation_id: "default",
    name: "gap",
    description: "gap",
    prompt: "hello",
    cron: `${occurrence.getUTCMinutes()} ${occurrence.getUTCHours()} * * *`,
    recurring: true,
    timezone: "UTC",
  });
  updateTask(task.id, (t) => {
    t.created_at = new Date(occurrence.getTime() - 86_400_000).toISOString();
    t.jitter_offset_ms = 30_000;
  });
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  let tick: (() => void) | undefined;
  let pendingFires = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const [handler, delay] = args;
    if (delay === 60_000) tick = handler as () => void;
    return realInterval(handler, delay);
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const [handler, delay] = args;
    if (delay === 30_000) pendingFires++;
    return realTimeout(handler, delay);
  }) as typeof setTimeout;
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "test",
        wsUrl: "wss://example.test",
        deviceId: "test",
        connectionName: "test",
        onConnected() {},
        onDisconnected() {},
        onError() {},
      },
      async () => {},
    );
    expect(pendingFires).toBe(1);
    expect(getIntendedCronOccurrence(task, now)).toEqual(occurrence);
    tick?.();
    expect(pendingFires).toBe(1);
  } finally {
    stopScheduler();
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
  }
});
