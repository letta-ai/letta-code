import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReflectionMemoryWorktree } from "@/agent/memory-worktree";
import { reflectionMemoryWorktreeHasNoChanges } from "@/cli/helpers/reflection-arena";

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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflection-arena-worktree-"));
  memoryDir = join(tempDir, "agent", "memory");
  git(tempDir, ["init", "-b", "main", memoryDir]);
  writeFileSync(join(memoryDir, "persona.md"), "base\n", "utf-8");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reflection arena worktree snapshots", () => {
  test("identifies a clean no-op worktree", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    expect(await reflectionMemoryWorktreeHasNoChanges(worktree)).toBe(true);
  });

  test("rejects committed and uncommitted memory changes", async () => {
    const committedWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(committedWorktree.worktreeDir, "committed.md"),
      "committed\n",
      "utf-8",
    );
    git(committedWorktree.worktreeDir, ["add", "committed.md"]);
    git(committedWorktree.worktreeDir, ["commit", "-m", "committed"]);

    const dirtyWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(dirtyWorktree.worktreeDir, "dirty.md"),
      "dirty\n",
      "utf-8",
    );

    expect(await reflectionMemoryWorktreeHasNoChanges(committedWorktree)).toBe(
      false,
    );
    expect(await reflectionMemoryWorktreeHasNoChanges(dirtyWorktree)).toBe(
      false,
    );
  });
});
