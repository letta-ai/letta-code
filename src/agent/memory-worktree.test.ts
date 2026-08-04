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
  buildReflectionIntegrationMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  reflectionIntegrationConsumesTranscript,
  reflectionMemoryParentHasChanges,
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
  test("integration scope makes both worktree and parent memory writable", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    const scope = buildReflectionIntegrationMemoryScope(worktree);

    expect(scope.primaryRoot).toBe(worktree.worktreeDir);
    expect(scope.writableRoots).toEqual([
      worktree.worktreeDir,
      worktree.parentMemoryDir,
      worktree.gitCommonDir,
    ]);
    expect(scope.readonlyRoots).toEqual([]);
    await finalizeReflectionMemoryWorktree(worktree, { shouldMerge: false });
  });

  test("detects uncommitted parent memory changes before launch", async () => {
    expect(await reflectionMemoryParentHasChanges(memoryDir)).toBe(false);

    writeMemoryFile("parent-dirty.md", "dirty\n");

    expect(await reflectionMemoryParentHasChanges(memoryDir)).toBe(true);
  });

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

  test("cleans up conflicted parent merges so the transcript can retry", async () => {
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

    expect(result.status).toBe("merge_conflict");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toBe(
      "parent\n",
    );
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
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

  test("finalizes a confirmed no-op after its worktree disappeared", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    git(memoryDir, ["worktree", "remove", "--force", worktree.worktreeDir]);
    git(memoryDir, ["branch", "-D", worktree.branchName]);

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
      knownNoChanges: true,
    });

    expect(result.status).toBe("no_changes");
    expect(result.commitCount).toBe(0);
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(true);
  });

  test("does not treat a missing committed worktree as a no-op", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(join(worktree.worktreeDir, "reflection.md"), "dream\n");
    git(worktree.worktreeDir, ["add", "reflection.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
    git(memoryDir, ["worktree", "remove", "--force", worktree.worktreeDir]);

    await expect(
      finalizeReflectionMemoryWorktree(worktree, {
        shouldMerge: true,
        knownNoChanges: true,
      }),
    ).rejects.toThrow("advanced");
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toContain(worktree.branchName);
  });

  test("cleans up when parent memory is dirty so the transcript can retry", async () => {
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

    expect(result.status).toBe("parent_dirty");
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
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

  test("classifies failed clean no-op worktrees as failed", async () => {
    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: false,
    });

    expect(result.status).toBe("failed");
    expect(result.commitCount).toBe(0);
    expect(reflectionIntegrationConsumesTranscript(result)).toBe(false);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toBe("");
  });
});
