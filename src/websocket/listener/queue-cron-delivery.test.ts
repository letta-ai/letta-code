import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addTask } from "@/cron/cron-file";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  runCronTaskNow,
  startScheduler,
  stopScheduler,
} from "@/cron/scheduler";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import { getActiveRuntime, setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";

test("a fired cron records queued then delivered with the same queue item ID", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "cron-delivery-"));
  const originalHome = process.env.LETTA_HOME;
  const originalSandbox = process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  const originalRuntime = getActiveRuntime();
  process.env.LETTA_HOME = home;
  delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
  try {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(listener, "agent-test", "default");
    const task = addTask({
      agent_id: "agent-test",
      conversation_id: "default",
      name: "Reminder",
      description: "Delivery test",
      cron: "0 0 * * *",
      recurring: false,
      prompt: "Check in",
      scheduled_for: new Date(Date.now() + 86_400_000),
    }).task;
    // A closed transport keeps the scheduled pump from draining before inspection.
    startScheduler(
      { readyState: 3 } as ListenerTransport,
      {
        connectionId: "conn-test",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-test",
        connectionName: "test",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );
    expect((await runCronTaskNow(task.id)).success).toBe(true);
    const logPath = getCronRunLogPath(task.id);
    const queued = readCronRunLogEntries(logPath);
    expect(queued.map((entry) => entry.outcome)).toEqual(["queued"]);

    const batch = consumeQueuedTurn(runtime)?.dequeuedBatch;
    expect(batch?.items[0]).toMatchObject({
      kind: "cron_prompt",
      cronTaskId: task.id,
      agentId: task.agent_id,
      id: queued[0]?.queueItemId,
    });
    const entries = readCronRunLogEntries(logPath);
    expect(entries.map((entry) => entry.outcome)).toEqual([
      "queued",
      "delivered",
    ]);
    expect(entries[1]).toMatchObject({
      status: "ok",
      reason: "dequeued",
      queueItemId: queued[0]?.queueItemId,
      conversationId: "default",
      runAtMs: expect.any(Number),
    });
  } finally {
    stopScheduler();
    setActiveRuntime(originalRuntime);
    if (originalHome === undefined) delete process.env.LETTA_HOME;
    else process.env.LETTA_HOME = originalHome;
    if (originalSandbox === undefined)
      delete process.env.LETTA_MANAGED_CLOUD_RUNTIME;
    else process.env.LETTA_MANAGED_CLOUD_RUNTIME = originalSandbox;
    rmSync(home, { recursive: true, force: true });
  }
});
