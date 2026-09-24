import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryConflictRepairClaim } from "@/agent/memory-conflict-repair";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import { ensureMemoryRepair } from "@/tools/impl/memory-task-lifecycle";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import {
  formatAttachedRepositoriesPostTurnSyncReminders,
  formatAttachedRepositoryPostTurnSyncReminder,
  runPostTurnMemorySync,
} from "./memory-git-sync";

describe("post-turn memory push notification", () => {
  test("waits for a successful push before notifying readers", async () => {
    let finishPush!: (result: MemoryPostTurnSyncResult) => void;
    const push = new Promise<MemoryPostTurnSyncResult>((resolve) => {
      finishPush = resolve;
    });
    let notifications = 0;
    const sync = runPostTurnMemorySync(
      {
        agentId: "agent-test",
        onMemoryPushed: () => {
          notifications++;
        },
      },
      {
        syncMemory: () => push,
        syncAttachedRepositories: async () => ({ results: [] }),
      },
    );

    await Promise.resolve();
    expect(notifications).toBe(0);
    finishPush({
      status: "pushed",
      summary: "Pushed",
      memoryDir: "/tmp/memory",
      localOnly: false,
    });
    await sync;
    expect(notifications).toBe(1);
  });

  test.each([
    "clean",
    "dirty",
    "conflict",
    "invalid",
    "push_failed",
    "skipped",
  ] as const)(
    "does not notify for %s memory, even if a shared repository was pushed",
    async (status) => {
      let notifications = 0;
      await runPostTurnMemorySync(
        {
          agentId: "agent-test",
          onMemoryPushed: () => {
            notifications++;
          },
        },
        {
          repairMemory: async () => true,
          syncMemory: async () => ({
            status,
            summary: status,
            memoryDir: "/tmp/memory",
            localOnly: false,
          }),
          syncAttachedRepositories: async () => ({
            results: [
              {
                name: "shared-notes",
                path: "/tmp/shared-notes",
                permissions: "read_write",
                status: "pushed",
                summary: "Pushed",
              },
            ],
          }),
        },
      );
      expect(notifications).toBe(0);
    },
  );
});

describe("shared-memory post-turn reminders", () => {
  test("asks the agent to commit dirty shared memory", () => {
    const reminder = formatAttachedRepositoryPostTurnSyncReminder({
      name: "shared-notes",
      path: "/tmp/shared-notes",
      permissions: "read_write",
      status: "dirty",
      summary: "2 uncommitted shared-memory changes.",
    });

    expect(reminder).toContain("SHARED MEMORY COMMIT NEEDED");
    expect(reminder).toContain('"shared-notes"');
    expect(reminder).toContain("/tmp/shared-notes");
    expect(reminder).toContain("harness pushes clean committed changes");
  });

  test("only returns reminders that need agent action", () => {
    const reminders = formatAttachedRepositoriesPostTurnSyncReminders({
      results: [
        {
          name: "published",
          path: "/tmp/published",
          permissions: "read_write",
          status: "pushed",
          summary: "Pushed 1 pending shared-memory commit.",
        },
        {
          name: "blocked",
          path: "/tmp/blocked",
          permissions: "read_write",
          status: "conflict",
          summary: "rebase in progress",
        },
      ],
    });

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain('"blocked"');
  });

  test("runs attached repository sync after the MemFS sync", async () => {
    const calls: string[] = [];

    await runPostTurnMemorySync(
      { agentId: "agent-test" },
      {
        syncMemory: async () => {
          calls.push("memory");
          return {
            status: "clean",
            summary: "clean",
            memoryDir: "/tmp/memory",
            localOnly: false,
          };
        },
        syncAttachedRepositories: async () => {
          calls.push("shared");
          return { results: [] };
        },
      },
    );

    expect(calls).toEqual(["memory", "shared"]);
  });

  test("still syncs attached repositories when the MemFS sync fails", async () => {
    let sharedSyncRan = false;

    await runPostTurnMemorySync(
      { agentId: "agent-test" },
      {
        syncMemory: async () => {
          throw new Error("MemFS unavailable");
        },
        syncAttachedRepositories: async () => {
          sharedSyncRan = true;
          return { results: [] };
        },
      },
    );

    expect(sharedSyncRan).toBe(true);
  });

  test("syncs attachments when MemFS sync is disabled", async () => {
    let memorySyncRan = false;
    let sharedSyncRan = false;

    await runPostTurnMemorySync(
      {
        agentId: "agent-test",
        isEnabled: () => false,
      },
      {
        syncMemory: async () => {
          memorySyncRan = true;
          throw new Error("should not run");
        },
        syncAttachedRepositories: async () => {
          sharedSyncRan = true;
          return { results: [] };
        },
      },
    );

    expect(memorySyncRan).toBe(false);
    expect(sharedSyncRan).toBe(true);
  });
});

const conflict: MemoryPostTurnSyncResult = {
  status: "conflict",
  memoryDir: "/tmp/test-memory-repair",
  summary: "merge in progress",
  localOnly: true,
};
/** A spawn stub that records the launched task's arguments. */
function spawnInto(jobs: SpawnBackgroundSubagentTaskArgs[]) {
  return (args: SpawnBackgroundSubagentTaskArgs) => {
    jobs.push(args);
    return {
      taskId: "task-repair",
      outputFile: "/tmp/repair.log",
      subagentId: "repair",
    };
  };
}
test("post-turn conflict launches a memory task and only guards the checkout", async () => {
  const jobs: SpawnBackgroundSubagentTaskArgs[] = [];
  const reminders: string[] = [];
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      conversationId: "conv-origin",
      enqueueReminder: (text) => {
        reminders.push(text);
      },
    },
    {
      syncMemory: async () => conflict,
      syncAttachedRepositories: async () => ({ results: [] }),
      repairMemory: (params) => ensureMemoryRepair(params, spawnInto(jobs)),
    },
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    subagentType: "memory",
    memoryRepairToken: expect.any(String),
    parentScope: {
      agentId: "agent-memory-repair-test",
      conversationId: "conv-origin",
    },
    memoryScope: {
      primaryRoot: conflict.memoryDir,
      writableRoots: [conflict.memoryDir],
    },
  });
  expect(jobs[0]?.existingConversationId).toBeUndefined();
  expect(jobs[0]?.existingAgentId).toBeUndefined();
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("MEMORY REPAIR RUNNING");
  expect(reminders[0]).toContain("Continue the current task");
  expect(reminders[0]).toContain("Do not inspect, edit, or run Git commands");
});

test("invalid committed memory launches history repair and only guards the checkout", async () => {
  const jobs: SpawnBackgroundSubagentTaskArgs[] = [];
  const reminders: string[] = [];
  const invalid: MemoryPostTurnSyncResult = {
    ...conflict,
    status: "invalid",
    summary:
      "core memory: 65556 characters exceeds 65536 from maxCoreMemoryCharacters",
  };
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      conversationId: "conv-origin",
      enqueueReminder: (text) => reminders.push(text),
    },
    {
      syncMemory: async () => invalid,
      syncAttachedRepositories: async () => ({ results: [] }),
      repairMemory: (params) =>
        ensureMemoryRepair(params, spawnInto(jobs), async () => ({
          status: "claimed",
          token: "invalid-history",
        })),
    },
  );

  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    subagentType: "memory",
    description: "Repair invalid memory history",
    memoryRepairToken: "invalid-history",
  });
  expect(jobs[0]?.prompt).toContain("unpublished memory history");
  expect(jobs[0]?.prompt).toContain("without retaining an invalid ancestor");
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("MEMORY REPAIR RUNNING");
  expect(reminders[0]).toContain("Continue the current task");
});

test("dirty primary memory still requests its unfinished commit", async () => {
  const messages: string[] = [];
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      enqueueReminder: (text) => {
        messages.push(text);
      },
      emitWarning: (text) => {
        messages.push(text);
      },
    },
    {
      syncMemory: async () => ({ ...conflict, status: "dirty" }),
      syncAttachedRepositories: async () => ({ results: [] }),
      repairMemory: () => {
        throw new Error("must not launch a repair");
      },
    },
  );
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("MEMORY COMMIT NEEDED");
  expect(messages[0]).toContain(conflict.memoryDir);
});

test("push failures report automatic retry without assigning foreground repair", async () => {
  const messages: string[] = [];
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      enqueueReminder: (text) => {
        messages.push(text);
      },
      emitWarning: (text) => {
        messages.push(text);
      },
    },
    {
      syncMemory: async () => ({ ...conflict, status: "push_failed" }),
      syncAttachedRepositories: async () => ({ results: [] }),
      repairMemory: () => {
        throw new Error("must not launch a repair");
      },
    },
  );
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("MEMORY SYNC RETRY");
  expect(messages[0]).toContain("Continue the current task");
  expect(messages[0]).toContain("Do not inspect or repair memory");
});

test("a conflict is reported to the primary only once repair has run on it", async () => {
  const jobs: SpawnBackgroundSubagentTaskArgs[] = [];
  const reminders: string[] = [];
  const spawn = spawnInto(jobs);
  const claims: MemoryConflictRepairClaim[] = [
    { status: "claimed", token: "attempt" },
    { status: "in_progress" },
    { status: "attempted" },
  ];
  const run = () =>
    runPostTurnMemorySync(
      {
        agentId: "agent-memory-repair-test",
        enqueueReminder: (text) => {
          reminders.push(text);
        },
      },
      {
        syncMemory: async () => conflict,
        syncAttachedRepositories: async () => ({ results: [] }),
        repairMemory: (params) =>
          ensureMemoryRepair(params, spawn, async () => {
            const claim = claims.shift();
            if (!claim) throw new Error("unexpected claim");
            return claim;
          }),
      },
    );
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("MEMORY REPAIR RUNNING");
  // The worker is still running, so the primary only sees the checkout guard.
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(2);
  expect(reminders[1]).toContain("MEMORY REPAIR RUNNING");
  // The worker ran and could not resolve it: report without assigning repair.
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(3);
  expect(reminders[2]).toContain("MEMORY GIT CONFLICT");
  expect(reminders[2]).toContain("Do not interrupt the current task");
});

test("post-turn sync is skipped while another writer owns the checkout", async () => {
  const home = mkdtempSync(join(tmpdir(), "memory-git-sync-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(getScopedMemoryFilesystemRoot("agent-test"), ".git"), {
      recursive: true,
    });
    let synced = false;
    await runPostTurnMemorySync(
      { agentId: "agent-test" },
      {
        claimOperation: async () => null,
        syncMemory: async () => {
          synced = true;
          throw new Error("must not sync a checkout someone else owns");
        },
        syncAttachedRepositories: async () => ({ results: [] }),
      },
    );
    expect(synced).toBe(false);
  } finally {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});
