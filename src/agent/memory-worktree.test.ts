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
import { basename, join } from "node:path";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  integratePendingReflectionMemoryWorktrees,
  listPendingReflectionMemoryWorktrees,
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
  git(memoryDir, ["config", "core.autocrlf", "false"]);
  git(memoryDir, ["config", "core.eol", "lf"]);
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

  test("aborts conflicted parent merges and preserves the reflection worktree", async () => {
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
    expect(existsSync(worktree.worktreeDir)).toBe(true);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toContain(worktree.branchName);
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

  test("lists only unmerged pending reflection worktrees", async () => {
    const pendingWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(pendingWorktree.worktreeDir, "pending.md"),
      "pending\n",
      "utf-8",
    );
    git(pendingWorktree.worktreeDir, ["add", "pending.md"]);
    git(pendingWorktree.worktreeDir, ["commit", "-m", "pending"]);

    const mergedWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(mergedWorktree.worktreeDir, "merged.md"),
      "merged\n",
      "utf-8",
    );
    git(mergedWorktree.worktreeDir, ["add", "merged.md"]);
    git(mergedWorktree.worktreeDir, ["commit", "-m", "merged"]);
    git(memoryDir, ["merge", mergedWorktree.branchName, "--no-edit"]);
    writeFileSync(
      join(mergedWorktree.worktreeDir, "dirty-after-merge.md"),
      "dirty\n",
      "utf-8",
    );

    const pending = await listPendingReflectionMemoryWorktrees(memoryDir);

    expect(pending.map((entry) => entry.reflectionBranch)).toEqual([
      pendingWorktree.branchName,
    ]);
    expect(existsSync(pending[0]?.reflectionWorktreeDir ?? "")).toBe(true);
    expect(
      pending[0]?.reflectionWorktreeDir
        .replace(/\\/g, "/")
        .endsWith(`/memory-worktrees/${basename(pendingWorktree.worktreeDir)}`),
    ).toBe(true);
    expect(existsSync(mergedWorktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", mergedWorktree.branchName]).trim(),
    ).toBe("");
  });

  test("integrates clean pending reflection worktrees in the background", async () => {
    const pendingWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(pendingWorktree.worktreeDir, "pending.md"),
      "pending\n",
      "utf-8",
    );
    git(pendingWorktree.worktreeDir, ["add", "pending.md"]);
    git(pendingWorktree.worktreeDir, [
      "commit",
      "-m",
      "fix(reflection): add pending memory",
    ]);

    const unresolved =
      await integratePendingReflectionMemoryWorktrees(memoryDir);

    expect(unresolved).toEqual([]);
    expect(readFileSync(join(memoryDir, "pending.md"), "utf-8")).toBe(
      "pending\n",
    );
    expect(existsSync(pendingWorktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", pendingWorktree.branchName]).trim(),
    ).toBe("");
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
  });

  test("preserves conflicted pending reflection worktrees for reminders", async () => {
    const pendingWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(pendingWorktree.worktreeDir, "persona.md"),
      "reflection\n",
      "utf-8",
    );
    git(pendingWorktree.worktreeDir, ["add", "persona.md"]);
    git(pendingWorktree.worktreeDir, ["commit", "-m", "reflection"]);

    writeMemoryFile("persona.md", "parent\n");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const unresolved =
      await integratePendingReflectionMemoryWorktrees(memoryDir);

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.status).toBe("pending_conflict");
    expect(unresolved[0]?.reflectionBranch).toBe(pendingWorktree.branchName);
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toBe(
      "parent\n",
    );
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(pendingWorktree.worktreeDir)).toBe(true);
  });

  test("defers pending reflection integration when parent memory is dirty", async () => {
    const pendingWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(pendingWorktree.worktreeDir, "pending.md"),
      "pending\n",
      "utf-8",
    );
    git(pendingWorktree.worktreeDir, ["add", "pending.md"]);
    git(pendingWorktree.worktreeDir, ["commit", "-m", "pending"]);
    writeMemoryFile("parent-dirty.md", "dirty\n");

    const unresolved =
      await integratePendingReflectionMemoryWorktrees(memoryDir);

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.status).toBe("pending_manual_merge");
    expect(unresolved[0]?.summary).toContain(
      "parent memory repo has uncommitted changes",
    );
    expect(unresolved[0]?.reflectionBranch).toBe(pendingWorktree.branchName);
    expect(existsSync(pendingWorktree.worktreeDir)).toBe(true);
  });

  test("defers pending reflection integration when reflection worktree is dirty", async () => {
    const pendingWorktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(pendingWorktree.worktreeDir, "pending.md"),
      "pending\n",
      "utf-8",
    );
    git(pendingWorktree.worktreeDir, ["add", "pending.md"]);
    git(pendingWorktree.worktreeDir, ["commit", "-m", "pending"]);
    writeFileSync(
      join(pendingWorktree.worktreeDir, "dirty.md"),
      "dirty\n",
      "utf-8",
    );

    const unresolved =
      await integratePendingReflectionMemoryWorktrees(memoryDir);

    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.status).toBe("pending_manual_merge");
    expect(unresolved[0]?.summary).toContain("uncommitted changes");
    expect(unresolved[0]?.reflectionBranch).toBe(pendingWorktree.branchName);
    expect(existsSync(pendingWorktree.worktreeDir)).toBe(true);
  });

  test("defers merge when parent memory has uncommitted changes", async () => {
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

    writeMemoryFile("parent.md", "dirty\n");

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("pending_manual_merge");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(true);
    expect(reflectionIntegrationNeedsReminder(result)).toBe(true);
    expect(existsSync(worktree.worktreeDir)).toBe(true);
    expect(readFileSync(join(memoryDir, "parent.md"), "utf-8")).toBe("dirty\n");
    expect(git(memoryDir, ["status", "--porcelain"])).toContain("?? parent.md");
  });

  test("cleans up dirty uncommitted reflection worktrees for retry", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(join(worktree.worktreeDir, "scratch.md"), "dirty\n", "utf-8");

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("dirty_uncommitted");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });

  test("cleans up failed committed reflection worktrees for retry", async () => {
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

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: false,
    });

    expect(result.status).toBe("failed");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });
});
