import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
import { finalizeReflectionMemoryWorktreeLaunch } from "@/cli/helpers/reflection-launcher";

let tempDir: string;
let memoryDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  });
}

function writeParentMemoryFile(relativePath: string, content: string): void {
  writeFileSync(join(memoryDir, relativePath), content, "utf-8");
}

async function finalizeLaunch(
  worktree: ReflectionMemoryWorktree,
  subagentSuccess: boolean,
) {
  return await finalizeReflectionMemoryWorktreeLaunch({
    worktree,
    subagentSuccess,
    subagentError: subagentSuccess ? undefined : "subagent failed",
    agentId: "agent-test",
    conversationId: "conv-test",
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
  });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflection-completion-"));
  memoryDir = join(tempDir, "agent", "memory");
  git(tempDir, ["init", "-b", "main", memoryDir]);
  git(memoryDir, ["config", "core.autocrlf", "false"]);
  git(memoryDir, ["config", "core.eol", "lf"]);
  writeParentMemoryFile("persona.md", "base\n");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reflection worktree completion messaging", () => {
  test("parent dirty defers merge but marks transcript reflected", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "reflection.md"),
      "dream\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "reflection.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
    writeParentMemoryFile("parent-dirty.md", "dirty\n");

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("pending_manual_merge");
    expect(result.integration.summary).toContain(
      "parent memory repo has uncommitted changes",
    );
    expect(result.completionSuccess).toBe(true);
    expect(result.completionMessage).toBe(
      "Dreamed; memory merge will finish after pending memory changes are resolved.",
    );
  });

  test("parent merge conflict defers merge but marks transcript reflected", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "persona.md"),
      "reflection\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "persona.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
    writeParentMemoryFile("persona.md", "parent\n");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("pending_conflict");
    expect(result.integration.summary).toContain("has conflicts");
    expect(result.completionSuccess).toBe(true);
    expect(result.completionMessage).toBe(
      "Dreamed; memory merge will finish after conflicts are resolved.",
    );
  });

  test("dirty reflection worktree retries transcript with dirty message", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(join(worktree.worktreeDir, "scratch.md"), "dirty\n", "utf-8");

    const result = await finalizeLaunch(worktree, true);

    expect(result.integration.status).toBe("dirty_uncommitted");
    expect(result.integration.summary).toContain("uncommitted changes");
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but memory changes were not committed cleanly; will retry later.",
    );
  });

  test("failed reflection retries transcript with failed update message", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "reflection.md"),
      "dream\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "reflection.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);

    const result = await finalizeLaunch(worktree, false);

    expect(result.integration.status).toBe("failed");
    expect(result.integration.summary).toContain(
      "subagent did not complete successfully",
    );
    expect(result.completionSuccess).toBe(false);
    expect(result.completionMessage).toBe(
      "Tried to reflect, but memory updates were not completed cleanly; will retry later.",
    );
  });
});
