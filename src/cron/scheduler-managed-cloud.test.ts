import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask, getTask } from "@/cron/cron-file";
import {
  isSchedulerRunning,
  runCronTaskNow,
  startScheduler,
  stopScheduler,
} from "@/cron/scheduler";
import type { ListenerTransport } from "@/websocket/listener/transport";

const TEST_DIR = path.join(import.meta.dir, "__scheduler_cloud_test_tmp__");
const originalHome = process.env.LETTA_HOME;
const originalSandboxId = process.env.LETTA_MANAGED_CLOUD_RUNTIME;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  process.env.LETTA_MANAGED_CLOUD_RUNTIME = "1";
});

afterEach(() => {
  stopScheduler();
  rmSync(TEST_DIR, { recursive: true, force: true });
  if (originalHome) process.env.LETTA_HOME = originalHome;
  else delete process.env.LETTA_HOME;
  if (originalSandboxId)
    process.env.LETTA_MANAGED_CLOUD_RUNTIME = originalSandboxId;
  else delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
});

test("managed Cloud sandbox neither starts nor manually runs local schedules", async () => {
  const task = addTask({
    agent_id: "agent-cloud",
    conversation_id: "conversation-cloud",
    name: "legacy local schedule",
    description: "persisted before Cloud-only scheduling",
    cron: "0 0 * * *",
    recurring: false,
    prompt: "must not run locally",
    scheduled_for: new Date(Date.now() + 60_000),
  }).task;

  startScheduler(
    {} as ListenerTransport,
    {
      connectionId: "conn-cloud",
      wsUrl: "wss://example.test/ws",
      deviceId: "unregistered-device",
      connectionName: "managed-cloud",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    },
    async () => {},
  );

  expect(isSchedulerRunning()).toBe(false);
  expect(await runCronTaskNow(task.id)).toEqual({
    success: false,
    found: false,
    error: "Local schedules cannot run in a managed Cloud sandbox",
  });
  expect(getTask(task.id)?.status).toBe("active");
});
