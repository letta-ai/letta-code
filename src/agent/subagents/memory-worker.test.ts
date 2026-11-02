import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimMemoryConflictRepair } from "@/agent/memory-conflict-repair";
import { claimMemoryOperation } from "@/agent/memory-operation";
import { __testSetBackend, type Backend } from "@/backend";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { runMemoryWorker } from "./memory-worker";

let repo: TempGitRepo;
let root: string;
function git(...args: string[]): string {
  return repo.git(...args);
}
beforeEach(() => {
  repo = createTempGitRepo("memory-worker-");
  root = repo.dir;
  writeFileSync(join(root, "note.md"), "original\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
  } as unknown as Backend);
});
afterEach(() => {
  __testSetBackend(null);
  repo.cleanup();
});
function scope(repairToken: string) {
  return {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: root,
    repairToken,
  };
}
/** Record a repair attempt, as post-turn sync does before launching a worker. */
async function claim(): Promise<string> {
  const result = await claimMemoryConflictRepair(root);
  expect(result.status).toBe("claimed");
  return result.status === "claimed" ? result.token : "";
}
const attemptStatus = async () =>
  (await claimMemoryConflictRepair(root)).status;
/** Leave the checkout mid-merge with a conflicted note.md. */
function conflict() {
  git("checkout", "-q", "-b", "other");
  writeFileSync(join(root, "note.md"), "other\n");
  git("commit", "-q", "-am", "other");
  git("checkout", "-q", "main");
  writeFileSync(join(root, "note.md"), "main\n");
  git("commit", "-q", "-am", "main");
  expect(() => git("merge", "other")).toThrow();
}
test("repairs a real Git conflict in place and skips a duplicate repair", async () => {
  conflict();
  let executions = 0;
  const repair = async (dir: string) => {
    executions++;
    expect(dir).toBe(root);
    writeFileSync(join(root, "note.md"), "resolved\n");
    git("add", "note.md");
    git("commit", "-q", "-m", "resolve conflict");
    return { agentId: "agent-repair", success: true, report: "repaired" };
  };
  await Promise.all([
    runMemoryWorker(scope("attempt"), repair),
    runMemoryWorker(scope("attempt"), repair),
  ]);
  expect(executions).toBe(1);
  expect(git("status", "--porcelain")).toBe("");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("resolved\n");
});

test("a repair that reports success without resolving is caught by the sync", async () => {
  conflict();
  const before = git("status", "--porcelain");
  let refreshed = false;
  const result = await runMemoryWorker(
    scope("attempt"),
    async () => ({ agentId: "agent-repair", success: true, report: "done" }),
    {
      recompile: async () => {
        refreshed = true;
        return "compiled";
      },
    },
  );
  expect(result.success).toBe(false);
  expect(git("status", "--porcelain")).toBe(before);
  expect(refreshed).toBe(false);
});

test("an invalid committed tree runs its repair worker in place", async () => {
  const token = await claim();
  let syncCalls = 0;
  let executions = 0;
  const result = await runMemoryWorker(
    scope(token),
    async (dir) => {
      executions++;
      expect(dir).toBe(root);
      return { agentId: "agent-repair", success: true, report: "replayed" };
    },
    {
      sync: async () => {
        syncCalls++;
        return syncCalls === 1
          ? {
              status: "invalid" as const,
              summary: "core memory exceeds maxCoreMemoryCharacters",
              memoryDir: root,
              localOnly: false,
            }
          : {
              status: "clean" as const,
              summary: "clean",
              memoryDir: root,
              localOnly: false,
            };
      },
    },
  );

  expect(executions).toBe(1);
  expect(result).toMatchObject({ success: true, report: "replayed" });
});

test("a queued repair that finds the conflict already pushed notifies without launching", async () => {
  let notified = false;
  const result = await runMemoryWorker(
    scope("attempt"),
    async () => {
      throw new Error("must not run");
    },
    {
      sync: async () => ({
        status: "pushed",
        summary: "Pushed resolved conflict",
        memoryDir: root,
        localOnly: false,
      }),
      onMemoryChanged: () => {
        notified = true;
      },
    },
  );
  expect(result).toEqual({
    agentId: "",
    success: true,
    report: "No memory conflict remains.",
  });
  expect(notified).toBe(true);
});

test("a queued repair reports a dirty checkout instead of declaring it repaired", async () => {
  const result = await runMemoryWorker(
    scope("attempt"),
    async () => {
      throw new Error("must not run");
    },
    {
      sync: async () => ({
        status: "dirty",
        summary: "1 uncommitted memory change(s).",
        memoryDir: root,
        localOnly: true,
      }),
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("Memory sync incomplete (dirty)");
});

test("a repair that ran marks its attempt done; the same conflict is reported next time", async () => {
  conflict();
  await runMemoryWorker(scope(await claim()), async () => ({
    agentId: "agent-repair",
    success: true,
    report: "could not resolve",
  }));
  // Still conflicted, and now recorded as attempted: no relaunch.
  expect(await attemptStatus()).toBe("attempted");
});

test("a repair cancelled before finishing forgets its attempt so the next turn retries", async () => {
  conflict();
  const controller = new AbortController();
  await runMemoryWorker(
    { ...scope(await claim()), signal: controller.signal },
    async () => {
      controller.abort();
      return { agentId: "agent-repair", success: false, report: "" };
    },
  );
  expect(await attemptStatus()).toBe("claimed");
});

test("a repair whose launch fails forgets its attempt so the next turn retries", async () => {
  conflict();
  await expect(
    runMemoryWorker(scope(await claim()), async () => {
      throw new Error("child exited before starting");
    }),
  ).rejects.toThrow("child exited before starting");
  expect(await attemptStatus()).toBe("claimed");
});

test("a repair cancelled while waiting for the checkout forgets its attempt", async () => {
  conflict();
  const token = await claim();
  const holder = await claimMemoryOperation(root);
  const controller = new AbortController();
  const waiting = runMemoryWorker(
    { ...scope(token), signal: controller.signal },
    async () => {
      throw new Error("must not run");
    },
  );
  await Bun.sleep(30);
  controller.abort();
  await expect(waiting).rejects.toThrow();
  await holder?.();
  expect(await attemptStatus()).toBe("claimed");
});

test("a repair whose initial sync throws forgets its attempt", async () => {
  conflict();
  await expect(
    runMemoryWorker(
      scope(await claim()),
      async () => {
        throw new Error("must not run");
      },
      {
        sync: async () => {
          throw new Error("remote unreachable");
        },
      },
    ),
  ).rejects.toThrow("remote unreachable");
  expect(await attemptStatus()).toBe("claimed");
});

test("a repair that finds nothing left to repair forgets its attempt", async () => {
  conflict();
  const token = await claim();
  // The primary abandoned the merge before the worker got the checkout.
  git("merge", "--abort");
  const result = await runMemoryWorker(scope(token), async () => {
    throw new Error("must not run");
  });
  expect(result.success).toBe(true);
  // Retrying the same merge is the same operation; it must be repaired anew.
  expect(() => git("merge", "other")).toThrow();
  expect(await attemptStatus()).toBe("claimed");
});

test("a late worker cannot forget a newer attempt for the same checkout", async () => {
  conflict();
  const stale = await claim();
  const holder = await claimMemoryOperation(root);
  const controller = new AbortController();
  const waiting = runMemoryWorker(
    { ...scope(stale), signal: controller.signal },
    async () => {
      throw new Error("must not run");
    },
  );
  await Bun.sleep(30);
  // Meanwhile the conflict changed and a new turn in the same process claimed
  // it, before the waiting worker was cancelled.
  writeFileSync(join(root, ".git", "MERGE_HEAD"), "b".repeat(40));
  await claim();
  controller.abort();
  await expect(waiting).rejects.toThrow();
  await holder?.();
  expect(await attemptStatus()).toBe("in_progress");
});
