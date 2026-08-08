import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRE_COMMIT_HOOK_SCRIPT } from "@/agent/memory-git-hooks";
import {
  DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT,
  MEMORY_TOKEN_LIMIT_POLICY_PATH,
} from "@/agent/memory-token-limit";
import { runMemorySubcommand } from "@/cli/subcommands/memory";

describe("letta memory token-limit", () => {
  let memoryDir: string;
  let previousMemoryDir: string | undefined;
  const previousGitEnv: Record<string, string | undefined> = {};

  function git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: memoryDir,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  beforeEach(() => {
    memoryDir = mkdtempSync(join(tmpdir(), "memory-token-limit-"));
    previousMemoryDir = process.env.MEMORY_DIR;
    process.env.MEMORY_DIR = memoryDir;
    for (const key of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ]) {
      previousGitEnv[key] = process.env[key];
    }
    process.env.GIT_AUTHOR_NAME = "Test Agent";
    process.env.GIT_AUTHOR_EMAIL = "test@example.com";
    process.env.GIT_COMMITTER_NAME = "Test Agent";
    process.env.GIT_COMMITTER_EMAIL = "test@example.com";

    git(["init"]);
    writeFileSync(join(memoryDir, ".gitkeep"), "");
    git(["add", ".gitkeep"]);
    git(["commit", "-m", "init"]);
    const hookPath = join(memoryDir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, PRE_COMMIT_HOOK_SCRIPT, { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(memoryDir, { recursive: true, force: true });
    if (previousMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = previousMemoryDir;
    for (const [key, value] of Object.entries(previousGitEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("gets the default token limit", async () => {
    const output: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    try {
      expect(await runMemorySubcommand(["token-limit", "get"])).toBe(0);
      expect(JSON.parse(output.join("\n"))).toMatchObject({
        limit: DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT,
        source: "default",
      });
    } finally {
      log.mockRestore();
    }
  });

  test("sets and commits the protected token limit", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runMemorySubcommand(["token-limit", "set", "30000"])).toBe(
        0,
      );
    } finally {
      log.mockRestore();
    }

    expect(
      readFileSync(join(memoryDir, MEMORY_TOKEN_LIMIT_POLICY_PATH), "utf8"),
    ).toBe("system_prompt_token_limit: 30000\n");
    expect(git(["log", "-1", "--pretty=%s"])).toBe(
      "config: set system prompt token limit to 30000",
    );
    expect(git(["status", "--porcelain"])).toBe("");
  });

  test("sets the limit without committing unrelated changes", async () => {
    const systemDir = join(memoryDir, "system");
    mkdirSync(systemDir, { recursive: true });
    const contextPath = join(systemDir, "context.md");
    writeFileSync(contextPath, "---\ndescription: Context\n---\n\nOriginal.\n");
    git(["add", "system/context.md"]);
    git(["commit", "-m", "add context"]);
    writeFileSync(contextPath, "---\ndescription: Context\n---\n\nModified.\n");

    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runMemorySubcommand(["token-limit", "set", "30000"])).toBe(
        0,
      );
    } finally {
      log.mockRestore();
    }

    expect(git(["status", "--porcelain", "--", "system/context.md"])).not.toBe(
      "",
    );
  });

  test("rejects a non-positive token limit", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runMemorySubcommand(["token-limit", "set", "0"])).toBe(64);
    } finally {
      error.mockRestore();
    }
  });
});
