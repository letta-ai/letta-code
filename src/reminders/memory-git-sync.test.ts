import { describe, expect, test } from "bun:test";
import {
  formatAttachedRepositoriesPostTurnSyncReminders,
  formatAttachedRepositoryPostTurnSyncReminder,
  runPostTurnMemorySync,
} from "./memory-git-sync";

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
