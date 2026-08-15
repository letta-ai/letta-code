import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { enter_worktree } from "@/tools/impl/enter-worktree";
import { exit_worktree } from "@/tools/impl/exit-worktree";
import { clearToolsWithLock } from "@/tools/manager";
import { acquireWorktreeLock, LOCK_FILENAME } from "@/utils/worktree-lock";
import { resetRemoteSettingsCache } from "@/websocket/listener/remote-settings";
import { setActiveRuntime } from "@/websocket/listener/runtime";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Letta Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Letta Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "letta-exit-worktree-repo-"));
  git(["init", "-b", "main"], repo);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial commit"], repo);
  return await realpath(repo);
}

async function lockExists(worktreeGitDir: string): Promise<boolean> {
  return await exists(path.join(worktreeGitDir, LOCK_FILENAME));
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe("ExitWorktree tool", () => {
  let tempDirs: string[] = [];
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalUserCwd = process.env.USER_CWD;

  beforeEach(async () => {
    tempDirs = [];
    clearToolsWithLock();
    resetRemoteSettingsCache();
    setActiveRuntime(null);
    const fakeHome = await mkdtemp(
      path.join(tmpdir(), "letta-exit-worktree-home-"),
    );
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await settingsManager.reset();
    await settingsManager.initialize();
  });

  afterEach(async () => {
    setActiveRuntime(null);
    clearToolsWithLock();
    resetRemoteSettingsCache();
    await settingsManager.reset();
    process.chdir(originalCwd);
    if (originalUserCwd === undefined) {
      delete process.env.USER_CWD;
    } else {
      process.env.USER_CWD = originalUserCwd;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function trackRepo(): Promise<string> {
    const repo = await createRepo();
    tempDirs.push(repo);
    return repo;
  }

  /** Create a worktree and return its path plus branch, without switching cwd. */
  async function makeWorktree(
    repo: string,
    name: string,
  ): Promise<{ worktreePath: string; branchName: string }> {
    const created = await runWithRuntimeContext(
      { workingDirectory: repo },
      () => enter_worktree({ name, refresh_base: false, switch_cwd: false }),
    );
    expect(created.status).toBe("success");
    if (!created.worktree_path || !created.branch_name) {
      throw new Error("Expected EnterWorktree to return a path and branch");
    }
    return {
      worktreePath: created.worktree_path,
      branchName: created.branch_name,
    };
  }

  test("is a no-op outside a managed worktree", async () => {
    const repo = await trackRepo();

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("Not in a managed worktree");
    expect(result.removed).toBeUndefined();
  });

  test("is a no-op outside a git repository", async () => {
    const plainDir = await mkdtemp(path.join(tmpdir(), "letta-exit-plain-"));
    tempDirs.push(plainDir);

    const result = await runWithRuntimeContext(
      { workingDirectory: plainDir },
      () => exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("Not inside a git repository");
  });

  test("rejects a missing or unknown action", async () => {
    const repo = await trackRepo();

    for (const action of [undefined, "delete"]) {
      const result = await runWithRuntimeContext(
        { workingDirectory: repo },
        () => exit_worktree(action === undefined ? {} : { action }),
      );
      expect(result.status).toBe("error");
      expect(result.content[0]?.text).toContain("Provide `action`");
    }
  });

  test("keep returns to the primary checkout and leaves the worktree on disk", async () => {
    const repo = await trackRepo();
    const { worktreePath, branchName } = await makeWorktree(repo, "Keep Me");

    const result = await runWithRuntimeContext(
      { workingDirectory: worktreePath },
      () => exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.returned_to).toBe(repo);
    expect(result.removed).toBe(false);
    // The TUI renderer parses these labeled fields; keep them in lockstep
    // with src/cli/components/ExitWorktreeResultRenderer.tsx.
    expect(result.content[0]?.text).toContain("Left worktree.");
    expect(result.content[0]?.text).toContain(`Path: ${worktreePath}`);
    expect(result.content[0]?.text).toContain(`Branch: ${branchName}`);
    expect(result.content[0]?.text).toContain(`CWD: ${repo}`);
    expect(await exists(worktreePath)).toBe(true);
    expect(git(["branch", "--list", branchName], repo)).toContain(branchName);
  });

  test("remove deletes a clean worktree and its branch", async () => {
    const repo = await trackRepo();
    const { worktreePath, branchName } = await makeWorktree(repo, "Remove Me");

    const result = await runWithRuntimeContext(
      { workingDirectory: worktreePath },
      () => exit_worktree({ action: "remove" }),
    );

    expect(result.status).toBe("success");
    expect(result.removed).toBe(true);
    expect(result.returned_to).toBe(repo);
    expect(result.content[0]?.text).toContain("Removed worktree.");
    expect(result.content[0]?.text).toContain(`Branch: deleted ${branchName}`);
    expect(await exists(worktreePath)).toBe(false);
    expect(git(["branch", "--list", branchName], repo)).toBe("");
  });

  test("remove refuses to discard uncommitted changes", async () => {
    const repo = await trackRepo();
    const { worktreePath } = await makeWorktree(repo, "Dirty Tree");
    await writeFile(path.join(worktreePath, "scratch.txt"), "wip\n");

    const result = await runWithRuntimeContext(
      { workingDirectory: worktreePath },
      () => exit_worktree({ action: "remove" }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("still holds work");
    expect(result.content[0]?.text).toContain("uncommitted change");
    expect(result.content[0]?.text).toContain("scratch.txt");
    // Nothing was touched: the refusal must not half-exit the session.
    expect(await exists(worktreePath)).toBe(true);
  });

  test("remove refuses to orphan commits that are not in the base ref", async () => {
    const repo = await trackRepo();
    const { worktreePath } = await makeWorktree(repo, "Committed Work");
    await writeFile(path.join(worktreePath, "feature.txt"), "done\n");
    git(["add", "feature.txt"], worktreePath);
    git(["commit", "-m", "add the feature"], worktreePath);

    const result = await runWithRuntimeContext(
      { workingDirectory: worktreePath },
      () => exit_worktree({ action: "remove" }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("commit(s) not in main");
    expect(result.content[0]?.text).toContain("add the feature");
    expect(await exists(worktreePath)).toBe(true);
  });

  test("discard_changes removes a dirty worktree and force-deletes its branch", async () => {
    const repo = await trackRepo();
    const { worktreePath, branchName } = await makeWorktree(repo, "Abandon It");
    await writeFile(path.join(worktreePath, "scratch.txt"), "wip\n");
    git(["add", "scratch.txt"], worktreePath);
    git(["commit", "-m", "abandoned work"], worktreePath);

    const result = await runWithRuntimeContext(
      { workingDirectory: worktreePath },
      () => exit_worktree({ action: "remove", discard_changes: true }),
    );

    expect(result.status).toBe("success");
    expect(result.removed).toBe(true);
    expect(await exists(worktreePath)).toBe(false);
    expect(git(["branch", "--list", branchName], repo)).toBe("");
  });

  test("exits from a subdirectory of the worktree", async () => {
    const repo = await trackRepo();
    const { worktreePath } = await makeWorktree(repo, "Nested Cwd");
    const nested = path.join(worktreePath, "src");
    await mkdir(nested, { recursive: true });

    const result = await runWithRuntimeContext(
      { workingDirectory: nested },
      () => exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.returned_to).toBe(repo);
  });

  test("releases this conversation's cross-agent lock on exit", async () => {
    const repo = await trackRepo();
    const { worktreePath } = await makeWorktree(repo, "Locked Tree");
    const worktreeGitDir = git(
      ["rev-parse", "--absolute-git-dir"],
      worktreePath,
    );
    const owner = { conversationId: "conv-exit", agentId: "agent-exit" };
    await acquireWorktreeLock({ worktreeGitDir, owner });
    expect(await lockExists(worktreeGitDir)).toBe(true);

    const result = await runWithRuntimeContext(
      {
        workingDirectory: worktreePath,
        conversationId: owner.conversationId,
        agentId: owner.agentId,
      },
      () => exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.content[0]?.text).toContain("Lock: released");
    expect(await lockExists(worktreeGitDir)).toBe(false);
  });

  test("leaves a lock held by a different conversation alone", async () => {
    const repo = await trackRepo();
    const { worktreePath } = await makeWorktree(repo, "Other Owner");
    const worktreeGitDir = git(
      ["rev-parse", "--absolute-git-dir"],
      worktreePath,
    );
    await acquireWorktreeLock({
      worktreeGitDir,
      owner: { conversationId: "someone-else", agentId: "other-agent" },
    });

    const result = await runWithRuntimeContext(
      {
        workingDirectory: worktreePath,
        conversationId: "conv-exit",
        agentId: "agent-exit",
      },
      () => exit_worktree({ action: "keep" }),
    );

    expect(result.status).toBe("success");
    expect(result.content[0]?.text).not.toContain("Lock:");
    expect(await lockExists(worktreeGitDir)).toBe(true);
  });
});
