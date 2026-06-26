import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  reflectionIntegrationConsumesTranscript,
  reflectionIntegrationNeedsReminder,
} from "@/agent/memory-worktree";

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

function writeMemoryFile(relativePath: string, content: string): void {
  const path = join(memoryDir, relativePath);
  writeFileSync(path, content, "utf-8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "reflection-memory-worktree-"));
  memoryDir = join(tempDir, "agent", "memory");
  rmSync(memoryDir, { recursive: true, force: true });
  git(tempDir, ["init", "-b", "main", memoryDir]);
  writeMemoryFile("persona.md", "base\n");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("reflection memory worktrees", () => {
  test("merges committed reflection changes after parent advances", async () => {
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

    writeMemoryFile("parent.md", "awake\n");
    git(memoryDir, ["add", "parent.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("merged");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(true);
    expect(readFileSync(join(memoryDir, "parent.md"), "utf-8")).toBe("awake\n");
    expect(readFileSync(join(memoryDir, "reflection.md"), "utf-8")).toBe(
      "dream\n",
    );
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });

  test("preserves a conflicted integration worktree and leaves parent main clean", async () => {
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

    writeMemoryFile("persona.md", "parent\n");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("pending_conflict");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(true);
    expect(reflectionIntegrationNeedsReminder(result)).toBe(true);
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toBe(
      "parent\n",
    );
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(result.integrationWorktreeDir).toBeTruthy();
    expect(existsSync(result.integrationWorktreeDir as string)).toBe(true);
    expect(
      git(result.integrationWorktreeDir as string, ["status", "--porcelain"]),
    ).toContain("UU persona.md");
  });

  test("cleans up a no-op reflection worktree", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("no_changes");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(true);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });

  test("leaves dirty uncommitted reflection worktrees unresolved", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(join(worktree.worktreeDir, "scratch.md"), "dirty\n", "utf-8");

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("dirty_uncommitted");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(existsSync(worktree.worktreeDir)).toBe(true);
  });
});
