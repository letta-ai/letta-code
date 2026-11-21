import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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

function startListenerScheduler(): void {
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
      onLog: () => {},
    },
    async () => {},
  );
}

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

  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    startListenerScheduler();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Wake or letta cron"),
    );
    expect(warn.mock.calls.flat().join(" ")).not.toContain(
      "registered computer",
    );
  } finally {
    warn.mockRestore();
  }

  expect(isSchedulerRunning()).toBe(false);
  expect(await runCronTaskNow(task.id)).toEqual({
    success: false,
    found: false,
    error:
      "This schedule cannot run here. Create a replacement with Wake or letta cron.",
  });
  expect(getTask(task.id)?.status).toBe("active");
});

test("a Cloud listener warns about a persisted recurring local schedule", () => {
  const env = {
    LETTA_MANAGED_CLOUD_RUNTIME: undefined,
    LETTA_DESKTOP_MODE: undefined,
    LETTA_RUNTIME_SESSION_SOURCE: "listen",
    LETTA_BASE_URL: "https://api.letta.com",
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: undefined,
  };
  const previous = Object.entries(env).map(
    ([key]) => [key, process.env[key]] as const,
  );
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    startListenerScheduler();
    expect(warn).not.toHaveBeenCalled();
    expect(isSchedulerRunning()).toBe(false);

    const { task } = addTask({
      agent_id: "agent-test",
      conversation_id: "conversation-test",
      name: "daily reminder",
      description: "daily reminder",
      cron: "0 9 * * *",
      recurring: true,
      prompt: "remind me",
      scheduled_for: new Date(Date.now() + 60_000),
    });
    const before = getTask(task.id);
    expect(before?.status).toBe("active");
    startListenerScheduler();
    expect(isSchedulerRunning()).toBe(false);
    expect(getTask(task.id)).toEqual(before);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /legacy local schedules.*cannot run here.*Wake or letta cron.*Cloud schedule.*registered computer/i,
      ),
    );
  } finally {
    warn.mockRestore();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
