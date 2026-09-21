import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimMemoryOperation } from "@/agent/memory-operation";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
import { __testSetBackend, type Backend } from "@/backend";
import { runMemoryWorker } from "./memory-worker";

let root: string;
function git(...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-worker-"));
  git("init", "-b", "main");
  git("config", "user.name", "Memory Test");
  git("config", "user.email", "memory@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "note.md"), "original\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
  } as unknown as Backend);
});
afterEach(() => {
  __testSetBackend(null);
  rmSync(root, { recursive: true, force: true });
});
function scope(repairOnly = false) {
  return {
    agentId: "agent-parent",
    conversationId: "conv-parent",
    memoryDir: root,
    repairOnly,
  };
}
function conflict() {
  git("checkout", "-b", "other");
  writeFileSync(join(root, "note.md"), "other\n");
  git("commit", "-am", "other");
  git("checkout", "main");
  writeFileSync(join(root, "note.md"), "main\n");
  git("commit", "-am", "main");
  expect(() => git("merge", "other")).toThrow();
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

test("repairs a real Git conflict and skips a duplicate repair after normal sync", async () => {
  conflict();
  let executions = 0;
  const repair = async () => {
    executions++;
    writeFileSync(join(root, "note.md"), "main and other\n");
    git("add", "note.md");
    git("commit", "-m", "resolve conflict");
    return { agentId: "agent-parent", success: true, report: "repaired" };
  };
  await Promise.all([
    runMemoryWorker(scope(true), repair),
    runMemoryWorker(scope(true), repair),
  ]);
  expect(executions).toBe(1);
  expect(git("status", "--porcelain")).toBe("");
});

test("normal sync detects an unresolved conflict despite a successful report", async () => {
  conflict();
  const before = git("status", "--porcelain");
  let refreshed = false;
  await runMemoryWorker(
    scope(true),
    async () => ({ agentId: "agent-parent", success: true, report: "done" }),
    {
      recompile: async () => {
        refreshed = true;
        return "compiled";
      },
    },
  );
  expect(git("status", "--porcelain")).toBe(before);
  expect(refreshed).toBe(false);
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

test("a sync conflict after an update triggers repair without another primary turn", async () => {
  const repairs: string[] = [];
  await runMemoryWorker(
    scope(),
    async () => {
      conflict();
      return { agentId: "agent-parent", success: true, report: "updated" };
    },
    {
      repair: (result) => {
        repairs.push(result.status);
      },
    },
  );
  expect(repairs).toEqual(["conflict"]);
  await runMemoryWorker(
    scope(true),
    async () => ({
      agentId: "agent-parent",
      success: false,
      report: "unresolved",
    }),
    {
      repair: () => {
        repairs.push("recursive repair");
      },
    },
  );
  expect(repairs).toEqual(["conflict"]);
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

test("a queued repair notifies after sync pushes an already-resolved conflict without launching a worker", async () => {
  let pushed = false;
  let notified = false;
  const result = await runMemoryWorker(
    scope(true),
    async () => {
      throw new Error("Conflict was already resolved");
    },
    {
      sync: async () => {
        pushed = true;
        return {
          status: "pushed",
          summary: "Pushed resolved conflict",
          memoryDir: root,
          localOnly: false,
        };
      },
      onMemoryPushed: () => {
        expect(pushed).toBe(true);
        notified = true;
      },
    },
  );
  expect(result.success).toBe(true);
  expect(notified).toBe(true);
});
