import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryConflictRepairClaim } from "@/agent/memory-conflict-repair";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import type { commitLeftoverMemoryChanges } from "@/agent/memory-leftovers";
import { ensureMemoryConflictRepair } from "@/tools/impl/memory-task-lifecycle";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import {
  formatAttachedRepositoryPostTurnSyncReminder,
  type RunPostTurnMemorySyncDependencies,
  resetPostTurnMemorySyncNotices,
  runPostTurnMemorySync,
} from "./memory-git-sync";

beforeEach(() => {
  resetPostTurnMemorySyncNotices();
});

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

  test.each(["clean", "dirty", "conflict", "push_failed", "skipped"] as const)(
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
          repairConflict: async () => true,
          commitLeftovers: async () => ({ committed: false, error: "stub" }),
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

  test("only states the agent can act on become reminders", () => {
    const reminder = (status: "pushed" | "push_failed" | "conflict") =>
      formatAttachedRepositoryPostTurnSyncReminder({
        name: "blocked",
        path: "/tmp/blocked",
        permissions: "read_write",
        status,
        summary: "status",
      });
    expect(reminder("pushed")).toBeNull();
    // A failed push is retried by the harness; the agent cannot fix it.
    expect(reminder("push_failed")).toBeNull();
    expect(reminder("conflict")).toContain('"blocked"');
  });

  test("a shared repository push failure is shown to the user once, not to the agent", async () => {
    const reminders: string[] = [];
    const warnings: string[] = [];
    const run = () =>
      runPostTurnMemorySync(
        {
          agentId: "agent-test",
          enqueueReminder: (text) => {
            reminders.push(text);
          },
          emitWarning: (text) => {
            warnings.push(text);
          },
        },
        {
          syncMemory: async () => ({
            status: "clean",
            summary: "clean",
            memoryDir: "/tmp/memory",
            localOnly: false,
          }),
          syncAttachedRepositories: async () => ({
            results: [
              {
                name: "shared-notes",
                path: "/tmp/shared-notes",
                permissions: "read_write",
                status: "push_failed",
                summary: "remote: 401 Unauthorized.",
              },
            ],
          }),
        },
      );
    await run();
    await run();
    expect(reminders).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"shared-notes"');
    expect(warnings[0]).toContain("401");
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
test("post-turn conflict launches the memory task and warns the primary, without a same-agent conversation", async () => {
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
      repairConflict: (params) =>
        ensureMemoryConflictRepair(params, spawnInto(jobs)),
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
  // The primary is told to leave the checkout alone while the repair runs.
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("MEMORY REPAIR IN PROGRESS");
  expect(reminders[0]).not.toContain("MEMORY GIT CONFLICT");
});
/**
 * Run post-turn sync against fixed MemFS results (one per sync call),
 * collecting what it delivers. Leftover commits are rejected unless a
 * `commitLeftovers` stub says otherwise.
 */
async function syncWith(
  results: MemoryPostTurnSyncResult | MemoryPostTurnSyncResult[],
  sinks: { reminders: string[]; warnings: string[] },
  commitLeftovers: RunPostTurnMemorySyncDependencies["commitLeftovers"] = async () => ({
    committed: false,
    error: "pre-commit hook: broken.md is missing frontmatter.",
  }),
): Promise<void> {
  const queue = Array.isArray(results) ? [...results] : [results];
  await runPostTurnMemorySync(
    {
      agentId: "agent-memory-repair-test",
      agentName: "Ada",
      enqueueReminder: (text) => {
        sinks.reminders.push(text);
      },
      emitWarning: (text) => {
        sinks.warnings.push(text);
      },
    },
    {
      syncMemory: async () => {
        const next = queue.shift();
        if (!next) throw new Error("unexpected extra sync");
        return next;
      },
      commitLeftovers,
      syncAttachedRepositories: async () => ({ results: [] }),
      repairConflict: () => {
        throw new Error("must not launch a conflict repair");
      },
    },
  );
}

test("changes left after the turn are committed as the agent and then pushed", async () => {
  const sinks = { reminders: [] as string[], warnings: [] as string[] };
  const commits: Parameters<typeof commitLeftoverMemoryChanges>[0][] = [];
  await syncWith(
    [
      {
        ...conflict,
        status: "dirty",
        summary: "1 uncommitted memory change(s).",
      },
      {
        ...conflict,
        status: "pushed",
        summary: "Pushed 1 pending memory commit(s).",
      },
    ],
    sinks,
    async (params) => {
      commits.push(params);
      return { committed: true };
    },
  );
  expect(commits).toEqual([
    {
      memoryDir: conflict.memoryDir,
      agentId: "agent-memory-repair-test",
      authorName: "Ada",
      localOnly: true,
    },
  ]);
  expect(sinks.reminders).toEqual([]);
  expect(sinks.warnings).toEqual([]);
});

test("what the pre-commit hook rejects is reported to the primary with the reason", async () => {
  const sinks = { reminders: [] as string[], warnings: [] as string[] };
  await syncWith({ ...conflict, status: "dirty" }, sinks);
  expect(sinks.reminders).toHaveLength(1);
  expect(sinks.reminders[0]).toContain("MEMORY COMMIT NEEDED");
  expect(sinks.reminders[0]).toContain(conflict.memoryDir);
  expect(sinks.reminders[0]).toContain("broken.md is missing frontmatter");
  expect(sinks.warnings).toEqual([]);
});

test("a failed push is shown to the user once and never becomes an agent reminder", async () => {
  const sinks = { reminders: [] as string[], warnings: [] as string[] };
  const failed: MemoryPostTurnSyncResult = {
    ...conflict,
    status: "push_failed",
    summary: "remote: 401 Unauthorized.",
  };
  await syncWith(failed, sinks);
  await syncWith(failed, sinks);
  expect(sinks.reminders).toEqual([]);
  expect(sinks.warnings).toHaveLength(1);
  expect(sinks.warnings[0]).toContain("Could not push the memory repository");
  expect(sinks.warnings[0]).toContain("401");
});

test("each conversation of the agent gets its own copy of a reminder", async () => {
  const dirty: MemoryPostTurnSyncResult = { ...conflict, status: "dirty" };
  const reminders: string[] = [];
  for (const conversationId of ["conv-a", "conv-b", "conv-a"]) {
    await runPostTurnMemorySync(
      {
        agentId: "agent-memory-repair-test",
        conversationId,
        enqueueReminder: (text) => {
          reminders.push(text);
        },
      },
      {
        syncMemory: async () => dirty,
        syncAttachedRepositories: async () => ({ results: [] }),
      },
    );
  }
  expect(reminders).toHaveLength(2);
});

test("an unchanged memory state is reminded once; a changed or cleared state again", async () => {
  const sinks = { reminders: [] as string[], warnings: [] as string[] };
  const dirty: MemoryPostTurnSyncResult = {
    ...conflict,
    status: "dirty",
    summary: "1 uncommitted memory change(s).",
  };
  await syncWith(dirty, sinks);
  await syncWith(dirty, sinks);
  expect(sinks.reminders).toHaveLength(1);
  await syncWith(
    { ...dirty, summary: "2 uncommitted memory change(s)." },
    sinks,
  );
  expect(sinks.reminders).toHaveLength(2);
  await syncWith({ ...conflict, status: "clean", summary: "clean" }, sinks);
  await syncWith(dirty, sinks);
  expect(sinks.reminders).toHaveLength(3);
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
        repairConflict: (params) =>
          ensureMemoryConflictRepair(params, spawn, async () => {
            const claim = claims.shift();
            if (!claim) throw new Error("unexpected claim");
            return claim;
          }),
      },
    );
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(1);
  expect(reminders[0]).toContain("MEMORY REPAIR IN PROGRESS");
  // The worker is still running: the primary was already told once.
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(1);
  // The worker ran and could not resolve it: hand it to the primary.
  await run();
  expect(jobs).toHaveLength(1);
  expect(reminders).toHaveLength(2);
  expect(reminders[1]).toContain("MEMORY GIT CONFLICT");
  expect(reminders[1]).toContain("automatic repair could not resolve");
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
