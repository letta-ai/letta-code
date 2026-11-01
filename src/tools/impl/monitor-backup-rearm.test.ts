import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __getMonitorBackupWakeIdForTests,
  __setMonitorBackupRearmDelayMsForTests,
  __setMonitorBackupWakeForTests,
  armMonitorBackup,
  cancelMonitorBackup,
  detachMonitorBackupsForProcessExit,
  noteMonitorBackupActivity,
} from "./monitor-backup";

const TASK_ID = "monitor-rearm-test";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for re-arm");
    await Bun.sleep(5);
  }
}

describe("Monitor backup replacement", () => {
  let active: Set<string>;
  let calls: string[];
  let nextId: number;
  let failure: "error" | "throw" | undefined;
  let createGate: Promise<void> | undefined;
  let releaseCreate: (() => void) | undefined;

  beforeEach(() => {
    active = new Set();
    calls = [];
    nextId = 0;
    failure = undefined;
    createGate = undefined;
    releaseCreate = undefined;
    __setMonitorBackupRearmDelayMsForTests(0);
    __setMonitorBackupWakeForTests(async (args) => {
      if (args.action === "create") {
        const id = `wake-${++nextId}`;
        calls.push(`create:${id}`);
        await createGate;
        if (failure === "throw") throw new Error("scheduler unavailable");
        if (failure === "error") {
          return {
            status: "error",
            content: JSON.stringify({ error: "too many wakes" }),
          };
        }
        active.add(id);
        return { status: "success", content: JSON.stringify({ id }) };
      }
      if (args.action === "cancel" && args.id) {
        calls.push(`cancel:${args.id}`);
        active.delete(args.id);
      }
      return { status: "success", content: "{}" };
    });
  });

  afterEach(async () => {
    releaseCreate?.();
    await cancelMonitorBackup(TASK_ID);
    detachMonitorBackupsForProcessExit();
    __setMonitorBackupWakeForTests(null);
    __setMonitorBackupRearmDelayMsForTests(null);
  });

  async function arm(): Promise<void> {
    await armMonitorBackup({
      taskId: TASK_ID,
      description: "Watch a deployment",
      afterSeconds: 600,
      scope: { agentId: "agent-rearm", conversationId: "conv-rearm" },
      isRunning: () => true,
    });
  }

  function blockCreation(): void {
    createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
  }

  test.each(["error", "throw"] as const)(
    "keeps the last durable wake when replacement creation fails: %s",
    async (mode) => {
      await arm();
      failure = mode;
      noteMonitorBackupActivity(TASK_ID);
      await waitFor(() => calls.includes("create:wake-2"));

      expect(active).toEqual(new Set(["wake-1"]));
      expect(__getMonitorBackupWakeIdForTests(TASK_ID)).toBe("wake-1");
      expect(calls).toEqual(["create:wake-1", "create:wake-2"]);

      // A later event can still replace the retained wake after recovery.
      failure = undefined;
      noteMonitorBackupActivity(TASK_ID);
      await waitFor(() => calls.includes("cancel:wake-1"));
      expect(active).toEqual(new Set(["wake-3"]));
      expect(__getMonitorBackupWakeIdForTests(TASK_ID)).toBe("wake-3");
    },
  );

  test("keeps the old wake while replacement creation is in flight", async () => {
    await arm();
    blockCreation();
    noteMonitorBackupActivity(TASK_ID);
    await waitFor(() => calls.includes("create:wake-2"));

    expect(active).toEqual(new Set(["wake-1"]));
    releaseCreate?.();
    await waitFor(() => calls.includes("cancel:wake-1"));
    expect(active).toEqual(new Set(["wake-2"]));
    expect(calls).toEqual(["create:wake-1", "create:wake-2", "cancel:wake-1"]);
  });

  test("cancels both wakes when stopped during replacement creation", async () => {
    await arm();
    blockCreation();
    noteMonitorBackupActivity(TASK_ID);
    await waitFor(() => calls.includes("create:wake-2"));

    const stopped = cancelMonitorBackup(TASK_ID);
    releaseCreate?.();
    await stopped;
    expect(active.size).toBe(0);
    expect(__getMonitorBackupWakeIdForTests(TASK_ID)).toBeNull();
  });

  test("preserves the old wake if process exit detaches an in-flight replacement", async () => {
    await arm();
    blockCreation();
    noteMonitorBackupActivity(TASK_ID);
    await waitFor(() => calls.includes("create:wake-2"));

    detachMonitorBackupsForProcessExit();
    releaseCreate?.();
    await waitFor(() => calls.includes("cancel:wake-2"));
    expect(active).toEqual(new Set(["wake-1"]));
    expect(calls).not.toContain("cancel:wake-1");
  });
});
