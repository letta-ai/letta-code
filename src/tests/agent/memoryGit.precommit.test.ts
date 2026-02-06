/**
 * Tests for the git pre-commit hook that validates frontmatter
 * in memory .md files.
 *
 * Each test creates a temp git repo, installs the hook, stages
 * a file, and verifies the commit succeeds or fails as expected.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRE_COMMIT_HOOK_SCRIPT } from "../../agent/memoryGit";

let tempDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: tempDir,
    encoding: "utf-8",
    env: GIT_ENV,
  });
}

function writeAndStage(relativePath: string, content: string): void {
  const fullPath = join(tempDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  git(`add ${relativePath}`);
}

function tryCommit(): { success: boolean; output: string } {
  try {
    const output = git('commit -m "test"');
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error
        ? (err as { stderr?: string }).stderr || err.message
        : String(err);
    return { success: false, output };
  }
}

/** Valid frontmatter for convenience */
const VALID_FM = "---\ndescription: Test block\nlimit: 20000\n---\n\n";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memgit-test-"));
  git("init");
  const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
  writeFileSync(join(tempDir, ".gitkeep"), "");
  git("add .gitkeep");
  git('commit -m "init"');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pre-commit hook: frontmatter required", () => {
  test("allows files with valid frontmatter", () => {
    writeAndStage(
      "memory/system/human/prefs.md",
      `${VALID_FM}Block content here.\n`,
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("rejects files without frontmatter", () => {
    writeAndStage(
      "memory/system/human/prefs.md",
      "Just plain content\nno frontmatter here\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing frontmatter");
  });

  test("rejects unclosed frontmatter", () => {
    writeAndStage(
      "memory/system/broken.md",
      "---\ndescription: oops\nlimit: 20000\n\nContent without closing ---\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("never closed");
  });
});

describe("pre-commit hook: required fields", () => {
  test("rejects missing description", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\nlimit: 20000\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing required field 'description'");
  });

  test("rejects missing limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: A block\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing required field 'limit'");
  });

  test("rejects empty description", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription:\nlimit: 20000\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("must not be empty");
  });
});

describe("pre-commit hook: field validation", () => {
  test("rejects non-integer limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nlimit: abc\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });

  test("rejects zero limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nlimit: 0\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });

  test("rejects negative limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nlimit: -5\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });

  test("rejects float limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nlimit: 20.5\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });

  test("allows limit with trailing whitespace", () => {
    writeAndStage(
      "memory/system/ok.md",
      "---\ndescription: test\nlimit: 20000  \n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("rejects unknown frontmatter key", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nlimit: 20000\ntypo_key: oops\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown frontmatter key");
  });
});

describe("pre-commit hook: read_only protection", () => {
  test("rejects modifying a read_only file", () => {
    // First commit: create a read_only file (bypass hook for setup)
    const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
    rmSync(hookPath);
    writeAndStage(
      "memory/system/skills.md",
      "---\ndescription: Skills\nlimit: 20000\nread_only: true\n---\n\nOriginal.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Second commit: try to modify it
    writeAndStage(
      "memory/system/skills.md",
      "---\ndescription: Skills\nlimit: 20000\nread_only: true\n---\n\nModified.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("read_only and cannot be modified");
  });

  test("rejects agent adding read_only to new file", () => {
    writeAndStage(
      "memory/system/new.md",
      "---\ndescription: New block\nlimit: 20000\nread_only: false\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("protected field");
  });

  test("rejects agent changing read_only value", () => {
    // First commit: create with read_only: false (from server pull)
    // Bypass the hook for initial setup
    const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
    rmSync(hookPath);
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\nread_only: false\n---\n\nContent.\n",
    );
    tryCommit();
    // Re-install hook
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Now try to change read_only
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\nread_only: true\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("protected field");
  });

  test("allows modifying content of non-read_only file (with read_only preserved)", () => {
    // First commit: file with read_only: false (from server)
    const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
    rmSync(hookPath);
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\nread_only: false\n---\n\nOriginal.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Modify content but keep read_only the same
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\nread_only: false\n---\n\nUpdated.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("rejects agent removing read_only field", () => {
    // First commit: file with read_only (from server)
    const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
    rmSync(hookPath);
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\nread_only: false\n---\n\nContent.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Remove read_only from frontmatter
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nlimit: 20000\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot be removed");
  });
});

describe("pre-commit hook: non-memory files", () => {
  test("ignores non-memory files", () => {
    writeAndStage("README.md", "---\nbogus: true\n---\n\nThis is fine.\n");
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("ignores non-md files in memory dir", () => {
    writeAndStage("memory/system/.sync-state.json", '{"bad": "frontmatter"}');
    const result = tryCommit();
    expect(result.success).toBe(true);
  });
});
