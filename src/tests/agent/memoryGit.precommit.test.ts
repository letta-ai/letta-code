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

// Extract the hook script from memoryGit (it's exported for testing)
// We'll import it directly since it's a constant
import { PRE_COMMIT_HOOK_SCRIPT } from "../../agent/memoryGit";

let tempDir: string;

function git(args: string): string {
  return execSync(`git ${args}`, {
    cwd: tempDir,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memgit-test-"));
  git("init");
  // Install the pre-commit hook
  const hookPath = join(tempDir, ".git", "hooks", "pre-commit");
  writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
  // Initial commit so we have HEAD
  writeFileSync(join(tempDir, ".gitkeep"), "");
  git("add .gitkeep");
  git('commit -m "init"');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("pre-commit hook: frontmatter validation", () => {
  test("allows files without frontmatter", () => {
    writeAndStage(
      "memory/system/human/prefs.md",
      "Just plain content\nno frontmatter here\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("allows files with valid frontmatter", () => {
    writeAndStage(
      "memory/system/persona/soul.md",
      "---\ndescription: My identity\nlimit: 20000\n---\n\nBlock content here.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("allows valid frontmatter with read_only", () => {
    writeAndStage(
      "memory/system/skills.md",
      "---\ndescription: Skills list\nlimit: 20000\nread_only: true\n---\n\nSkills content.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("rejects label key (label is implicit from path)", () => {
    writeAndStage(
      "memory/system/test.md",
      "---\nlabel: custom/label\ndescription: A test block\nlimit: 5000\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown frontmatter key");
  });

  test("rejects unclosed frontmatter", () => {
    writeAndStage(
      "memory/system/broken.md",
      "---\ndescription: oops no closing\nlimit: 20000\n\nContent without closing ---\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("never closed");
  });

  test("rejects unknown frontmatter key", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\ntypo_key: oops\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("unknown frontmatter key");
  });

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

  test("rejects invalid read_only value", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription: valid\nread_only: yes\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("true or false");
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

  test("rejects negative limit", () => {
    writeAndStage("memory/system/bad.md", "---\nlimit: -5\n---\n\nContent.\n");
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });

  test("rejects float limit", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\nlimit: 20.5\n---\n\nContent.\n",
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

  test("rejects capitalized read_only", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\nread_only: True\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("true or false");
  });

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
