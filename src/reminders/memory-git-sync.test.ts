import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
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
