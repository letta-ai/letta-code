import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
function scope() {
  return {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: root,
  };
}

test("commits an update before normal sync and parent context refresh", async () => {
  const refreshed: string[] = [];
  await runMemoryWorker(
    scope(),
    async () => {
      expect(await claimMemoryOperation(root)).toBeNull();
      writeFileSync(join(root, "note.md"), "corrected preference\n");
      git("commit", "-am", "remember correction");
      return { agentId: "agent-parent", success: true, report: "saved" };
    },
    {
      recompile: async (conversationId, agentId) => {
        expect(git("status", "--porcelain")).toBe("");
        refreshed.push(`${agentId}:${conversationId}`);
        return "compiled";
      },
    },
  );
  expect(refreshed).toEqual(["agent-parent:conv-parent"]);
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("simultaneous updates read the latest committed memory without overlapping edits", async () => {
  const update = (text: string) =>
    runMemoryWorker(scope(), async () => {
      const prior = readFileSync(join(root, "note.md"), "utf8");
      await Bun.sleep(20);
      writeFileSync(join(root, "note.md"), `${prior}${text}\n`);
      git("commit", "-am", text);
      return { agentId: "agent-parent", success: true, report: text };
    });
  await Promise.all([update("first"), update("second")]);
  expect(
    readFileSync(join(root, "note.md"), "utf8").split("\n").sort(),
  ).toEqual(["", "first", "original", "second"]);
  expect(git("status", "--porcelain")).toBe("");
});

test("failed launches release the checkout and keep unrelated dirty files", async () => {
  writeFileSync(join(root, "unrelated.md"), "in progress");
  await expect(
    runMemoryWorker(scope(), async () => {
      throw new Error("launch failed");
    }),
  ).rejects.toThrow("launch failed");
  expect(readFileSync(join(root, "unrelated.md"), "utf8")).toBe("in progress");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("reflection integrates its own worktree after a memory edit releases the checkout", async () => {
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: root,
  });
  writeFileSync(
    join(worktree.worktreeDir, "reflection.md"),
    "reflection finding\n",
  );
  execFileSync("git", ["-C", worktree.worktreeDir, "add", "reflection.md"]);
  execFileSync(
    "git",
    ["-C", worktree.worktreeDir, "commit", "-m", "reflection"],
    { stdio: "pipe" },
  );
  let editing = () => {};
  const started = new Promise<void>((resolve) => {
    editing = resolve;
  });
  let finishEdit = () => {};
  const finish = new Promise<void>((resolve) => {
    finishEdit = resolve;
  });
  const edit = runMemoryWorker(scope(), async () => {
    writeFileSync(join(root, "note.md"), "explicit correction\n");
    editing();
    await finish;
    git("commit", "-am", "correction");
    return { agentId: "agent-parent", success: true, report: "saved" };
  });
  await started;
  let integrated = false;
  const integration = finalizeReflectionMemoryWorktree(worktree, {
    shouldMerge: true,
  }).then((result) => {
    integrated = true;
    return result;
  });
  await Bun.sleep(20);
  expect(integrated).toBe(false);
  finishEdit();
  await edit;
  expect((await integration).status).toBe("merged");
  expect(readFileSync(join(root, "note.md"), "utf8")).toBe(
    "explicit correction\n",
  );
  expect(readFileSync(join(root, "reflection.md"), "utf8")).toBe(
    "reflection finding\n",
  );
});

test("failed remote sync preserves the worker identity and report and releases the checkout", async () => {
  const result = await runMemoryWorker(
    scope(),
    async () => {
      writeFileSync(join(root, "note.md"), "remembered locally\n");
      git("commit", "-am", "save memory");
      return {
        agentId: "agent-worker",
        conversationId: "conv-worker",
        success: true,
        report: "Committed note.md",
      };
    },
    {
      sync: async () => ({
        status: "push_failed",
        summary: "Remote timed out",
        memoryDir: root,
        localOnly: false,
      }),
    },
  );
  expect(result).toMatchObject({
    agentId: "agent-worker",
    conversationId: "conv-worker",
    success: false,
    report: "Committed note.md",
    error: "Memory sync incomplete (push_failed): Remote timed out",
  });
  expect(git("status", "--porcelain")).toBe("");
  const release = await claimMemoryOperation(root);
  expect(release).not.toBeNull();
  await release?.();
});

test("a failed prompt refresh does not fail a worker whose memory synced", async () => {
  const result = await runMemoryWorker(
    scope(),
    async () => {
      writeFileSync(join(root, "note.md"), "refreshed preference\n");
      git("commit", "-am", "remember preference");
      return { agentId: "agent-worker", success: true, report: "saved" };
    },
    {
      recompile: async () => {
        throw new Error("server unavailable");
      },
    },
  );
  expect(result).toMatchObject({ success: true, report: "saved" });
  expect(result.error).toBeUndefined();
  expect(git("status", "--porcelain")).toBe("");
});
