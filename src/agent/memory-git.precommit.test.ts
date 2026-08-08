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

import { PRE_COMMIT_HOOK_SCRIPT } from "@/agent/memory-git-hooks";
import {
  DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT,
  formatMemoryTokenLimit,
  MEMORY_TOKEN_LIMIT_POLICY_PATH,
  MEMORY_TOKEN_LIMIT_UPDATE_ENV,
} from "@/agent/memory-token-limit";

let tempDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(args: string, env: NodeJS.ProcessEnv = GIT_ENV): string {
  return execSync(`git ${args}`, {
    cwd: tempDir,
    encoding: "utf-8",
    env,
  });
}

function writeAndStage(relativePath: string, content: string): void {
  const fullPath = join(tempDir, relativePath);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  git(`add ${relativePath}`);
}

function tryCommit(env: NodeJS.ProcessEnv = GIT_ENV): {
  success: boolean;
  output: string;
} {
  try {
    const output = git('commit -m "test"', env);
    return { success: true, output };
  } catch (err) {
    const output =
      err instanceof Error
        ? (err as { stderr?: string }).stderr || err.message
        : String(err);
    return { success: false, output };
  }
}

function installPolicy(limit: number): void {
  writeAndStage(MEMORY_TOKEN_LIMIT_POLICY_PATH, formatMemoryTokenLimit(limit));
  git('commit -m "set policy"', {
    ...GIT_ENV,
    [MEMORY_TOKEN_LIMIT_UPDATE_ENV]: "1",
  });
}

/** Valid frontmatter for convenience */
const VALID_FM = "---\ndescription: Test block\n---\n\n";

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
      "---\ndescription: oops\n\nContent without closing ---\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("never closed");
  });
});

describe("pre-commit hook: required fields", () => {
  test("rejects missing description", () => {
    writeAndStage("memory/system/bad.md", "---\n---\n\nContent.\n");
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing required field 'description'");
  });

  test("rejects empty description", () => {
    writeAndStage(
      "memory/system/bad.md",
      "---\ndescription:\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("must not be empty");
  });
});

describe("pre-commit hook: field validation", () => {
  test("allows legacy limit key for backward compatibility", () => {
    writeAndStage(
      "memory/system/ok.md",
      "---\ndescription: test\nlimit: legacy\n---\n\nContent.\n",
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
      "---\ndescription: Skills\nread_only: true\n---\n\nOriginal.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Second commit: try to modify it
    writeAndStage(
      "memory/system/skills.md",
      "---\ndescription: Skills\nread_only: true\n---\n\nModified.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("read_only and cannot be modified");
  });

  test("rejects agent adding read_only to new file", () => {
    writeAndStage(
      "memory/system/new.md",
      "---\ndescription: New block\nread_only: false\n---\n\nContent.\n",
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
      "---\ndescription: A block\nread_only: false\n---\n\nContent.\n",
    );
    tryCommit();
    // Re-install hook
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Now try to change read_only
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nread_only: true\n---\n\nContent.\n",
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
      "---\ndescription: A block\nread_only: false\n---\n\nOriginal.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Modify content but keep read_only the same
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\nread_only: false\n---\n\nUpdated.\n",
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
      "---\ndescription: A block\nread_only: false\n---\n\nContent.\n",
    );
    tryCommit();
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });

    // Remove read_only from frontmatter
    writeAndStage(
      "memory/system/block.md",
      "---\ndescription: A block\n---\n\nContent.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot be removed");
  });
});

describe("pre-commit hook: skill path guard", () => {
  test("rejects legacy flat skill file in nested memory layout", () => {
    writeAndStage(
      "memory/skills/slack-search.md",
      `${VALID_FM}Legacy flat skill file.\n`,
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("Use skills/<name>/SKILL.md");
  });

  test("rejects legacy flat skill file in top-level layout", () => {
    writeAndStage("skills/slack-search.md", "Legacy flat skill file.\n");
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("Use skills/<name>/SKILL.md");
  });

  test("allows canonical directory-based skill path", () => {
    writeAndStage("skills/slack-search/SKILL.md", "# Slack Search\n");
    const result = tryCommit();
    expect(result.success).toBe(true);
  });
});

describe("pre-commit hook: top-level layout (no memory/ prefix)", () => {
  test("validates frontmatter for system files without memory/ prefix", () => {
    writeAndStage(
      "system/human.md",
      "Just plain content\nno frontmatter here\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing frontmatter");
  });

  test("allows valid frontmatter in system files without memory/ prefix", () => {
    writeAndStage("system/human.md", `${VALID_FM}Block content here.\n`);
    const result = tryCommit();
    expect(result.success).toBe(true);
  });

  test("validates frontmatter for reference files without memory/ prefix", () => {
    writeAndStage("reference/notes.md", "No frontmatter\n");
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("missing frontmatter");
  });

  test("skips SKILL.md files inside skill directories", () => {
    writeAndStage(
      "skills/my-skill/SKILL.md",
      "# My Skill\nNo frontmatter needed.\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(true);
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

describe("pre-commit hook: system prompt token limit", () => {
  const contentWithEstimatedTokens = (tokens: number): string => {
    const frontmatter = "---\ndescription: Large block\n---\n\n";
    return `${frontmatter}${"x".repeat(tokens * 4 - Buffer.byteLength(frontmatter))}`;
  };

  test("allows a staged system prompt below the default limit", () => {
    writeAndStage(
      "system/context.md",
      contentWithEstimatedTokens(DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT - 1),
    );
    expect(tryCommit().success).toBe(true);
  });

  test("rejects a staged system prompt equal to the default limit", () => {
    writeAndStage(
      "system/context.md",
      contentWithEstimatedTokens(DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT),
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain(
      `must be less than ${DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT} tokens`,
    );
  });

  test("enforces the default limit for legacy memory/system repos", () => {
    writeAndStage(
      "memory/system/context.md",
      contentWithEstimatedTokens(DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT),
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain(
      `must be less than ${DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT} tokens`,
    );
  });

  test("uses the configured per-repo limit", () => {
    installPolicy(100);
    writeAndStage("system/context.md", contentWithEstimatedTokens(100));
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("must be less than 100 tokens");
  });

  test("sums nested system files", () => {
    installPolicy(100);
    writeAndStage("system/human/one.md", contentWithEstimatedTokens(50));
    writeAndStage("system/project/two.md", contentWithEstimatedTokens(50));
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("approximately 100 tokens");
  });

  test("estimates the staged snapshot rather than unstaged content", () => {
    writeAndStage("system/context.md", contentWithEstimatedTokens(100));
    writeFileSync(
      join(tempDir, "system/context.md"),
      contentWithEstimatedTokens(DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT),
      "utf-8",
    );
    expect(tryCommit().success).toBe(true);
  });

  test("rejects changing the tracked policy without approval", () => {
    installPolicy(100);
    writeAndStage(MEMORY_TOKEN_LIMIT_POLICY_PATH, formatMemoryTokenLimit(200));
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("memory policy is protected");
  });

  test("rejects deleting the tracked policy without approval", () => {
    installPolicy(100);
    git(`rm ${MEMORY_TOKEN_LIMIT_POLICY_PATH}`);
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("memory policy is protected");
  });

  test("rejects an invalid tracked policy", () => {
    writeAndStage(
      MEMORY_TOKEN_LIMIT_POLICY_PATH,
      "system_prompt_token_limit: nope\n",
    );
    const result = tryCommit();
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive integer");
  });
});
