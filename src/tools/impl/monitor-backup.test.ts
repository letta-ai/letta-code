import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { monitor, stopMonitorsForProcessExit } from "./monitor";
import {
  __getMonitorBackupWakeIdForTests,
  __setMonitorBackupRearmDelayMsForTests,
  __setMonitorBackupWakeForTests,
} from "./monitor-backup";
import { backgroundProcesses } from "./process_manager";
import { task_stop } from "./task-stop";

const SCOPE = {
  agentId: "agent-backup-test",
  conversationId: "conv-backup-test",
  actingUserId: "user-backup-test",
};

interface WakeCall {
  action: string;
  id?: string;
  name?: string;
  prompt?: string;
  after_seconds?: number;
  agentId?: string | null;
  conversationId?: string | null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting");
    await Bun.sleep(10);
  }
}

describe("Monitor backup wake", () => {
  let scratchpad: string;
  let previousScratchpad: string | undefined;
  let calls: WakeCall[];
  let nextId: number;
  let scriptIndex: number;

  function nodeCommand(script: string): string {
    const path = join(scratchpad, `backup-child-${scriptIndex}.js`);
    scriptIndex += 1;
    writeFileSync(path, script);
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
  }

  beforeEach(async () => {
    previousScratchpad = process.env.LETTA_SCRATCHPAD;
    scratchpad = mkdtempSync(join(tmpdir(), "monitor-backup-test-"));
    process.env.LETTA_SCRATCHPAD = scratchpad;
    calls = [];
    nextId = 0;
    scriptIndex = 0;
    clearPendingMessages();
    setMessageQueueAdder((_message: QueuedMessage) => {});
    __setMonitorBackupRearmDelayMsForTests(0);
    const { getRuntimeContext } = await import("@/runtime-context");
    __setMonitorBackupWakeForTests(async (args) => {
      const context = getRuntimeContext();
      calls.push({
        action: args.action,
        id: args.id,
        name: args.name,
        prompt: args.prompt,
        after_seconds: args.after_seconds,
        agentId: context?.agentId,
        conversationId: context?.conversationId,
      });
      if (args.action === "create") {
        nextId += 1;
        return {
          status: "success" as const,
          content: JSON.stringify({ action: "created", id: `wake-${nextId}` }),
        };
      }
      return {
        status: "success" as const,
        content: JSON.stringify({ action: "cancelled", id: args.id }),
      };
    });
  });

  afterEach(() => {
    stopMonitorsForProcessExit();
    backgroundProcesses.clear();
    __setMonitorBackupWakeForTests(null);
    __setMonitorBackupRearmDelayMsForTests(null);
    setMessageQueueAdder(null);
    if (previousScratchpad === undefined) {
      delete process.env.LETTA_SCRATCHPAD;
    } else {
      process.env.LETTA_SCRATCHPAD = previousScratchpad;
    }
    rmSync(scratchpad, { recursive: true, force: true });
  });

  function inScope<T>(fn: () => T): T {
    return runWithRuntimeContext(SCOPE, fn);
  }

  test("rejects out-of-range backup_after_seconds", async () => {
    await expect(
      inScope(() =>
        monitor({
          description: "deploy",
          command: "true",
          backup_after_seconds: 30,
        }),
      ),
    ).rejects.toThrow("backup_after_seconds");
    expect(calls).toEqual([]);
  });

  test("arms a durable wake in the monitor's conversation on start", async () => {
    const result = await inScope(() =>
      monitor({
        description: "Deploy completion or failure",
        command: nodeCommand("setInterval(() => {}, 1000);"),
        persistent: true,
        backup_after_seconds: 900,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      action: "create",
      after_seconds: 900,
      agentId: SCOPE.agentId,
      conversationId: SCOPE.conversationId,
      name: "Monitor backup: Deploy completion or failure",
    });
    expect(calls[0]?.prompt).toContain(
      'Monitor "Deploy completion or failure"',
    );
    expect(calls[0]?.prompt).toContain("silent for 15 min");
    expect(result.content[0]?.text).toContain("Backup wake wake-1 armed");
    expect(__getMonitorBackupWakeIdForTests(result.taskId)).toBe("wake-1");
  });

  test("uses a custom backup_prompt", async () => {
    await inScope(() =>
      monitor({
        description: "deploy",
        command: nodeCommand("setInterval(() => {}, 1000);"),
        persistent: true,
        backup_after_seconds: 120,
        backup_prompt: "Check run 123 and post in the thread.",
      }),
    );
    expect(calls[0]?.prompt).toBe("Check run 123 and post in the thread.");
  });

  test("each event re-arms the wake from that event", async () => {
    const result = await inScope(() =>
      monitor({
        description: "deploy",
        command: nodeCommand(
          "console.log('queued'); setInterval(() => {}, 1000);",
        ),
        persistent: true,
        backup_after_seconds: 600,
      }),
    );

    await waitFor(() => calls.length >= 3);
    expect(calls.map((call) => call.action)).toEqual([
      "create",
      "cancel",
      "create",
    ]);
    expect(calls[1]?.id).toBe("wake-1");
    expect(calls[2]?.after_seconds).toBe(600);
    await waitFor(
      () => __getMonitorBackupWakeIdForTests(result.taskId) === "wake-2",
    );
  });

  test("cancels the wake when the monitor exits", async () => {
    const result = await inScope(() =>
      monitor({
        description: "build",
        command: nodeCommand("setTimeout(() => process.exit(0), 300);"),
        backup_after_seconds: 300,
      }),
    );

    await waitFor(() => calls.some((call) => call.action === "cancel"));
    expect(calls.at(-1)).toMatchObject({ action: "cancel", id: "wake-1" });
    expect(__getMonitorBackupWakeIdForTests(result.taskId)).toBeNull();
  });

  test("cancels the wake when the monitor is stopped with TaskStop", async () => {
    const result = await inScope(() =>
      monitor({
        description: "logs",
        command: nodeCommand("setInterval(() => {}, 1000);"),
        persistent: true,
        backup_after_seconds: 300,
      }),
    );

    await task_stop({ task_id: result.taskId });
    await waitFor(() => calls.some((call) => call.action === "cancel"));
    expect(calls.at(-1)).toMatchObject({ action: "cancel", id: "wake-1" });
  });

  test("leaves the wake armed when the process exits", async () => {
    await inScope(() =>
      monitor({
        description: "long job",
        command: nodeCommand("setInterval(() => {}, 1000);"),
        persistent: true,
        backup_after_seconds: 300,
      }),
    );

    stopMonitorsForProcessExit();
    await Bun.sleep(50);
    expect(calls.map((call) => call.action)).toEqual(["create"]);
  });

  test("starts the monitor and explains when the wake cannot be armed", async () => {
    __setMonitorBackupWakeForTests(async () => ({
      status: "error" as const,
      content: JSON.stringify({ error: "too many wakes" }),
    }));
    const result = await inScope(() =>
      monitor({
        description: "deploy",
        command: nodeCommand("setInterval(() => {}, 1000);"),
        persistent: true,
        backup_after_seconds: 300,
      }),
    );
    expect(backgroundProcesses.get(result.taskId)?.status).toBe("running");
    expect(result.content[0]?.text).toContain(
      "Backup wake not armed: too many wakes",
    );
  });

  test("does nothing when backup_after_seconds is unset", async () => {
    await inScope(() =>
      monitor({
        description: "deploy",
        command: nodeCommand("console.log('x'); setInterval(() => {}, 1000);"),
        persistent: true,
      }),
    );
    await Bun.sleep(100);
    expect(calls).toEqual([]);
  });
});
