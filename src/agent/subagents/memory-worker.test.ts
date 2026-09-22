import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimMemoryOperation } from "@/agent/memory-operation";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
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
/** Run git inside a worker's private worktree. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
function scope(repairOnly = false) {
  return {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: root,
    repairOnly,
  };
}
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
const conflictSync = async () => ({
  status: "conflict" as const,
  summary: "merge in progress",
  memoryDir: root,
  localOnly: true,
});
const localSync = (status: "skipped" | "clean") => async () => ({
  status,
  summary: status,
  memoryDir: root,
  localOnly: true,
});

test("a worker edits a private worktree; its commit is merged, synced and refreshed", async () => {
  const refreshed: string[] = [];
  let workerDir = "";
  await runMemoryWorker(
    scope(),
    async (dir, memoryScope) => {
      workerDir = dir;
      expect(dir).not.toBe(root);
      expect(memoryScope.primaryRoot).toBe(dir);
      expect(await claimMemoryOperation(root)).toBeNull();
      writeFileSync(join(dir, "note.md"), "corrected preference\n");
      gitIn(dir, "commit", "-am", "remember correction");
      return { agentId: "agent-worker", success: true, report: "saved" };
    },
    {
      sync: localSync("skipped"),
      recompile: async (conversationId, agentId) => {
        expect(git("status", "--porcelain")).toBe("");
        refreshed.push(`${agentId}:${conversationId}`);
        return "compiled";
      },
    },
  );
  expect(refreshed).toEqual(["agent-parent:conv-parent"]);
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe(
    "corrected preference\n",
  );
  expect(git("log", "--format=%s", "-1")).toBe("remember correction");
  expect(existsSync(workerDir)).toBe(false);
  expect(git("branch", "--list", "letta/memory-worker/*")).toBe("");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("simultaneous updates each start from the latest merged memory", async () => {
  const update = (text: string) =>
    runMemoryWorker(
      scope(),
      async (dir) => {
        const prior = readFileSync(join(dir, "note.md"), "utf8");
        await Bun.sleep(20);
        writeFileSync(join(dir, "note.md"), `${prior}${text}\n`);
        gitIn(dir, "commit", "-am", text);
        return { agentId: "agent-worker", success: true, report: text };
      },
      { sync: localSync("skipped") },
    );
  await Promise.all([update("first"), update("second")]);
  expect(
    readFileSync(join(root, "note.md"), "utf8").split("\n").sort(),
  ).toEqual(["", "first", "original", "second"]);
  expect(git("status", "--porcelain")).toBe("");
});

test("failed launches report the error, release the checkout and keep the primary's dirty files", async () => {
  writeFileSync(join(root, "unrelated.md"), "in progress");
  const result = await runMemoryWorker(scope(), async () => {
    throw new Error("launch failed");
  });
  expect(result.success).toBe(false);
  expect(result.error).toBe("launch failed");
  expect(readFileSync(join(root, "unrelated.md"), "utf8")).toBe("in progress");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("cancellation discards the worker's worktree and never touches the primary's edits", async () => {
  const controller = new AbortController();
  let synced = false;
  let workerDir = "";
  const result = await runMemoryWorker(
    { ...scope(), signal: controller.signal },
    async (dir) => {
      workerDir = dir;
      // The primary edits the same file in the checkout meanwhile.
      writeFileSync(join(root, "note.md"), "primary in progress\n");
      writeFileSync(join(root, "draft.md"), "primary draft\n");
      writeFileSync(join(dir, "note.md"), "worker half-written\n");
      writeFileSync(join(dir, "new.md"), "worker file\n");
      controller.abort();
      throw new Error("cancelled");
    },
    {
      sync: async () => {
        synced = true;
        throw new Error("must not sync a cancelled worker");
      },
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toBe("cancelled");
  expect(synced).toBe(false);
  expect(existsSync(workerDir)).toBe(false);
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe(
    "primary in progress\n",
  );
  expect(readFileSync(join(root, "draft.md"), "utf8")).toBe("primary draft\n");
  expect(existsSync(join(root, "new.md"))).toBe(false);
  expect(git("branch", "--list", "letta/memory-worker/*")).toBe("");
});

test("a worker commit that conflicts with the primary's is kept on its branch", async () => {
  const result = await runMemoryWorker(
    scope(),
    async (dir) => {
      // The primary commits a competing change while the worker runs.
      writeFileSync(join(root, "note.md"), "primary version\n");
      git("commit", "-am", "primary edit");
      writeFileSync(join(dir, "note.md"), "worker version\n");
      gitIn(dir, "commit", "-am", "worker edit");
      return { agentId: "agent-worker", success: true, report: "edited" };
    },
    { sync: localSync("clean") },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("letta/memory-worker/");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("primary version\n");
  expect(git("status", "--porcelain")).toBe("");
  expect(git("branch", "--list", "letta/memory-worker/*")).not.toBe("");
});

test("reflection integrates its own worktree after a memory edit releases the checkout", async () => {
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: root,
  });
  writeFileSync(
    join(worktree.worktreeDir, "reflection.md"),
    "reflection finding\n",
  );
  gitIn(worktree.worktreeDir, "add", "reflection.md");
  gitIn(worktree.worktreeDir, "commit", "-m", "reflection");
  let editing = () => {};
  const editingStarted = new Promise<void>((resolve) => {
    editing = resolve;
  });
  let finishEdit = () => {};
  const editGate = new Promise<void>((resolve) => {
    finishEdit = resolve;
  });
  const memoryEdit = runMemoryWorker(
    scope(),
    async (dir) => {
      editing();
      await editGate;
      writeFileSync(join(dir, "note.md"), "memory edit\n");
      gitIn(dir, "commit", "-am", "memory edit");
      return { agentId: "agent-worker", success: true, report: "edited" };
    },
    { sync: localSync("skipped") },
  );
  await editingStarted;
  let integrated = false;
  const integration = finalizeReflectionMemoryWorktree(worktree, {
    shouldMerge: true,
  }).then((result) => {
    integrated = true;
    return result;
  });
  await Bun.sleep(30);
  expect(integrated).toBe(false);
  finishEdit();
  await memoryEdit;
  expect((await integration).status).toBe("merged");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("memory edit\n");
  expect(existsSync(join(root, "reflection.md"))).toBe(true);
});

test("failed remote sync preserves the worker identity and report and releases the checkout", async () => {
  const result = await runMemoryWorker(
    scope(),
    async (dir) => {
      writeFileSync(join(dir, "note.md"), "updated\n");
      gitIn(dir, "commit", "-am", "update");
      return { agentId: "agent-worker", success: true, report: "saved" };
    },
    {
      sync: async () => ({
        status: "push_failed",
        summary: "Push rejected",
        memoryDir: root,
        localOnly: false,
      }),
    },
  );
  expect(result).toMatchObject({
    agentId: "agent-worker",
    success: false,
    report: "saved",
  });
  expect(result.error).toContain("push_failed");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe("updated\n");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("a failed prompt refresh does not fail a worker whose memory synced", async () => {
  const result = await runMemoryWorker(
    scope(),
    async (dir) => {
      writeFileSync(join(dir, "note.md"), "refreshed preference\n");
      gitIn(dir, "commit", "-am", "remember preference");
      return { agentId: "agent-worker", success: true, report: "saved" };
    },
    {
      sync: localSync("skipped"),
      recompile: async () => {
        throw new Error("server unavailable");
      },
    },
  );
  expect(result).toMatchObject({ success: true, report: "saved" });
  expect(result.error).toBeUndefined();
  expect(git("status", "--porcelain")).toBe("");
});

test("a merged commit reports that memory changed even without a remote", async () => {
  let changed = 0;
  await runMemoryWorker(
    scope(),
    async (dir) => {
      writeFileSync(join(dir, "note.md"), "local update\n");
      gitIn(dir, "commit", "-am", "local update");
      return { agentId: "agent-worker", success: true, report: "saved" };
    },
    {
      sync: localSync("skipped"),
      onMemoryChanged: () => {
        changed++;
      },
    },
  );
  expect(changed).toBe(1);
});

test("a worker that changed nothing does not report a memory change", async () => {
  let changed = 0;
  await runMemoryWorker(
    scope(),
    async () => ({ agentId: "agent-worker", success: true, report: "noop" }),
    {
      sync: localSync("clean"),
      onMemoryChanged: () => {
        changed++;
      },
    },
  );
  expect(changed).toBe(0);
  expect(git("branch", "--list", "letta/memory-worker/*")).toBe("");
});

test("a worker that crashes after committing still has its commit merged, synced and reported", async () => {
  let changed = 0;
  const result = await runMemoryWorker(
    scope(),
    async (dir) => {
      writeFileSync(join(dir, "note.md"), "committed before crash\n");
      gitIn(dir, "commit", "-am", "partial work");
      throw new Error("child exited with code 1");
    },
    {
      sync: localSync("skipped"),
      onMemoryChanged: () => {
        changed++;
      },
    },
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("exited with code 1");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe(
    "committed before crash\n",
  );
  expect(changed).toBe(1);
  expect(git("branch", "--list", "letta/memory-worker/*")).toBe("");
});

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
    runMemoryWorker(scope(true), repair),
    runMemoryWorker(scope(true), repair),
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
    scope(true),
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

test("a sync conflict after an update triggers repair before the worker completes", async () => {
  let launched = false;
  const result = await runMemoryWorker(
    scope(),
    async (dir) => {
      writeFileSync(join(dir, "note.md"), "edited\n");
      gitIn(dir, "commit", "-am", "edit");
      return { agentId: "agent-worker", success: true, report: "edited" };
    },
    {
      sync: conflictSync,
      repair: async () => {
        await Bun.sleep(20);
        launched = true;
      },
    },
  );
  expect(launched).toBe(true);
  expect(result.success).toBe(false);
  expect(result.error).toContain("conflict");
});

test("a queued repair that finds the conflict already pushed notifies without launching", async () => {
  let notified = false;
  const result = await runMemoryWorker(
    scope(true),
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
    scope(true),
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
