import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitMemoryWrite,
  getMemoryHeadRevision,
  initializeLocalMemoryRepo,
} from "@/agent/memory-git";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
} from "@/agent/memory-worktree";

/**
 * Regression tests for operator machines with commit signing enabled
 * globally (`commit.gpgsign=true`). The agent's committer identity
 * (`<agentId>@letta.com`) has no signing key, so any signing attempt fails
 * with "gpg: signing failed: No secret key" and blocked memory init:
 *
 *   Command failed: git -c user.name=Tutor -c user.email=agent-local-...@letta.com
 *     commit --allow-empty -m chore: initialize empty local memory
 *   error: gpg failed to sign the data
 *
 * The suite points GIT_CONFIG_GLOBAL at a config that demands signing with
 * a nonexistent gpg binary, so any signing attempt fails loudly.
 */

const AGENT_ID = "agent-local-signing-test";

let tempDir: string;
let originalGitConfigGlobal: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memory-git-signing-"));
  const globalConfigPath = join(tempDir, "gitconfig");
  writeFileSync(
    globalConfigPath,
    [
      "[commit]",
      "\tgpgsign = true",
      "[gpg]",
      `\tprogram = ${join(tempDir, "nonexistent-gpg").replace(/\\/g, "/")}`,
      "[user]",
      "\tname = Human Operator",
      "\temail = human@example.com",
      "",
    ].join("\n"),
    "utf-8",
  );
  originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
});

afterEach(() => {
  if (originalGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Test-setup git runner: disables signing explicitly for seed commits. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
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

const PERSONA_FILE = {
  relativePath: "system/persona.md",
  content: "---\ndescription: Agent persona\n---\nI am a test agent.\n",
};

describe("memory git commit signing", () => {
  test("initializeLocalMemoryRepo creates the empty init commit when global config demands signing", async () => {
    const memoryDir = join(tempDir, "memory-empty");

    await initializeLocalMemoryRepo({
      memoryDir,
      agentId: AGENT_ID,
      authorName: "Tutor",
      files: [],
    });

    const head = await getMemoryHeadRevision(memoryDir);
    expect(head).not.toBeNull();
    const subject = git(memoryDir, ["log", "-1", "--pretty=%s"]).trim();
    expect(subject).toBe("chore: initialize empty local memory");
    // Repo-local default keeps direct `git commit` runs unsigned too.
    const localGpgSign = git(memoryDir, [
      "config",
      "--local",
      "--get",
      "commit.gpgsign",
    ]).trim();
    expect(localGpgSign).toBe("false");
  });

  test("initializeLocalMemoryRepo commits seeded memory files when global config demands signing", async () => {
    const memoryDir = join(tempDir, "memory-seeded");

    await initializeLocalMemoryRepo({
      memoryDir,
      agentId: AGENT_ID,
      authorName: "Tutor",
      files: [PERSONA_FILE],
    });

    expect(existsSync(join(memoryDir, "system", "persona.md"))).toBe(true);
    const subject = git(memoryDir, ["log", "-1", "--pretty=%s"]).trim();
    expect(subject).toBe("chore: initialize local memory");
    const author = git(memoryDir, ["log", "-1", "--pretty=%an <%ae>"]).trim();
    expect(author).toBe(`Tutor <${AGENT_ID}@letta.com>`);
  });

  test("commitMemoryWrite (local sync mode) commits when global config demands signing", async () => {
    const memoryDir = join(tempDir, "memory-write");
    await initializeLocalMemoryRepo({
      memoryDir,
      agentId: AGENT_ID,
      authorName: "Tutor",
      files: [PERSONA_FILE],
    });

    writeFileSync(
      join(memoryDir, "system", "persona.md"),
      "---\ndescription: Agent persona\n---\nI am an updated test agent.\n",
      "utf-8",
    );

    const result = await commitMemoryWrite({
      memoryDir,
      pathspecs: ["system/persona.md"],
      reason: "Update persona",
      author: {
        agentId: AGENT_ID,
        authorName: "Tutor",
        authorEmail: `${AGENT_ID}@letta.com`,
      },
      syncMode: "local",
    });

    expect(result.committed).toBe(true);
    expect(result.sha).toBeDefined();
  });

  test("an explicit local commit.gpgsign override is preserved, and harness commits still succeed", async () => {
    const memoryDir = join(tempDir, "memory-override");
    await initializeLocalMemoryRepo({
      memoryDir,
      agentId: AGENT_ID,
      authorName: "Tutor",
      files: [PERSONA_FILE],
    });

    git(memoryDir, ["config", "--local", "commit.gpgsign", "true"]);

    writeFileSync(
      join(memoryDir, "system", "persona.md"),
      "---\ndescription: Agent persona\n---\nOverride round trip.\n",
      "utf-8",
    );
    const result = await commitMemoryWrite({
      memoryDir,
      pathspecs: ["system/persona.md"],
      reason: "Update persona with local override set",
      author: {
        agentId: AGENT_ID,
        authorName: "Tutor",
        authorEmail: `${AGENT_ID}@letta.com`,
      },
      syncMode: "local",
    });

    expect(result.committed).toBe(true);
    // Deliberate operator override is respected (set-if-unset semantics).
    const localGpgSign = git(memoryDir, [
      "config",
      "--local",
      "--get",
      "commit.gpgsign",
    ]).trim();
    expect(localGpgSign).toBe("true");
  });

  test("reflection worktree merge commits succeed when global config demands signing", async () => {
    // Plain repo without harness-managed local config, so the merge result
    // pins memory-worktree's own signing opt-out rather than repo config.
    const memoryDir = join(tempDir, "agent", "memory");
    git(tempDir, ["init", "-b", "main", memoryDir]);
    writeFileSync(join(memoryDir, "persona.md"), "base\n", "utf-8");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "init"]);

    const worktree = await createReflectionMemoryWorktree({
      parentMemoryDir: memoryDir,
    });

    writeFileSync(
      join(worktree.worktreeDir, "persona.md"),
      "base\nreflection change\n",
      "utf-8",
    );
    git(worktree.worktreeDir, ["add", "persona.md"]);
    git(worktree.worktreeDir, ["commit", "-m", "chore: reflection update"]);

    // Advance the parent so the merge is a true merge commit (the case
    // where git attempts to sign).
    writeFileSync(join(memoryDir, "notes.md"), "parent change\n", "utf-8");
    git(memoryDir, ["add", "notes.md"]);
    git(memoryDir, ["commit", "-m", "parent update"]);

    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });

    expect(result.status).toBe("merged");
    expect(result.commitCount).toBe(1);
  });
});
