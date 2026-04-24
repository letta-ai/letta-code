import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getCurrentWorkingDirectory,
  runWithRuntimeContext,
} from "../../runtime-context";
import { create_worktree } from "../../tools/impl/CreateWorktree";
import { __listenClientTestUtils } from "../../websocket/listen-client";
import { resetRemoteSettingsCache } from "../../websocket/listener/remote-settings";
import { setActiveRuntime } from "../../websocket/listener/runtime";

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
  const repo = await mkdtemp(
    path.join(tmpdir(), "letta-create-worktree-repo-"),
  );
  git(["init", "-b", "main"], repo);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial commit"], repo);
  return await realpath(repo);
}

describe("CreateWorktree tool", () => {
  let tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tempDirs = [];
    resetRemoteSettingsCache();
    setActiveRuntime(null);
  });

  afterEach(async () => {
    setActiveRuntime(null);
    resetRemoteSettingsCache();
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

  test("creates a canonical worktree without switching cwd when requested", async () => {
    const repo = await trackRepo();

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      create_worktree({
        name: "Fix Login Flow",
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    expect(result.worktree_path).toBe(
      path.join(repo, ".letta", "worktrees", "fix-login-flow"),
    );
    if (!result.worktree_path) {
      throw new Error("Expected CreateWorktree to return a worktree path");
    }
    expect(result.branch_name).toStartWith("letta/fix-login-flow-");
    expect(result.base_ref).toBe("main");
    expect(result.switched_cwd).toBe(false);
    expect(git(["rev-parse", "--show-toplevel"], result.worktree_path)).toBe(
      result.worktree_path,
    );
  });

  test("switches only the active conversation cwd", async () => {
    const repo = await trackRepo();
    const fakeHome = await mkdtemp(
      path.join(tmpdir(), "letta-create-worktree-home-"),
    );
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    resetRemoteSettingsCache();

    const listener = __listenClientTestUtils.createListenerRuntime();
    listener.bootWorkingDirectory = repo;
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-b",
    );
    setActiveRuntime(listener);

    const result = await runWithRuntimeContext(
      {
        agentId: "agent-1",
        conversationId: "conv-a",
        workingDirectory: repo,
      },
      async () => {
        const toolResult = await create_worktree({
          name: "Conversation A Feature",
          refresh_base: false,
        });
        if (!toolResult.worktree_path) {
          throw new Error("Expected CreateWorktree to return a worktree path");
        }
        expect(getCurrentWorkingDirectory()).toBe(toolResult.worktree_path);
        return toolResult;
      },
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected CreateWorktree to return a worktree path");
    }
    expect(
      __listenClientTestUtils.getConversationWorkingDirectory(
        listener,
        "agent-1",
        "conv-a",
      ),
    ).toBe(result.worktree_path);
    expect(
      __listenClientTestUtils.getConversationWorkingDirectory(
        listener,
        "agent-1",
        "conv-b",
      ),
    ).toBe(repo);
  });

  test("fetches the remote default branch before creating the worktree", async () => {
    const repo = await trackRepo();
    const remote = await mkdtemp(
      path.join(tmpdir(), "letta-create-worktree-remote-"),
    );
    const otherClone = await mkdtemp(
      path.join(tmpdir(), "letta-create-worktree-clone-"),
    );
    tempDirs.push(remote, otherClone);

    git(["init", "--bare", "-b", "main"], remote);
    git(["remote", "add", "origin", remote], repo);
    git(["push", "-u", "origin", "main"], repo);

    git(["clone", remote, otherClone], path.dirname(otherClone));
    await writeFile(path.join(otherClone, "REMOTE.md"), "latest remote\n");
    git(["add", "REMOTE.md"], otherClone);
    git(["commit", "-m", "remote update"], otherClone);
    git(["push", "origin", "main"], otherClone);

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      create_worktree({
        name: "Latest Remote",
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected CreateWorktree to return a worktree path");
    }
    expect(result.base_ref).toBe("origin/main");
    const remoteFile = await readFile(
      path.join(result.worktree_path, "REMOTE.md"),
      "utf8",
    );
    expect(remoteFile.replace(/\r\n/g, "\n")).toBe("latest remote\n");
  });

  test("returns an error outside a git repository", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "letta-create-worktree-empty-"),
    );
    tempDirs.push(dir);

    const result = await runWithRuntimeContext({ workingDirectory: dir }, () =>
      create_worktree({ name: "No Repo", refresh_base: false }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("rev-parse");
  });
});
