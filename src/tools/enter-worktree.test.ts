import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  getCurrentWorkingDirectory,
  runWithRuntimeContext,
} from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  addWindowsPathLengthHint,
  enter_worktree,
} from "@/tools/impl/enter-worktree";
import {
  clearToolsWithLock,
  executeTool,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  acquireWorktreeLock,
  releaseWorktreeLock,
} from "@/utils/worktree-lock";
import { __listenClientTestUtils } from "@/websocket/listen-client";
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
  const repo = await mkdtemp(path.join(tmpdir(), "letta-enter-worktree-repo-"));
  git(["init", "-b", "main"], repo);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  git(["add", "README.md"], repo);
  git(["commit", "-m", "initial commit"], repo);
  return await realpath(repo);
}

function toolReturnText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (
          item &&
          typeof item === "object" &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(value);
}

describe("EnterWorktree tool", () => {
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
      path.join(tmpdir(), "letta-enter-worktree-home-"),
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

  test("creates a canonical worktree without switching cwd when requested", async () => {
    const repo = await trackRepo();

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
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
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(result.branch_name).toStartWith("letta/fix-login-flow-");
    expect(result.base_ref).toBe("main");
    expect(result.switched_cwd).toBe(false);
    expect(result.content[0]?.text).toContain(
      "Provisioning: nothing to copy, symlink, or link.",
    );
    expect(
      path.normalize(
        git(["rev-parse", "--show-toplevel"], result.worktree_path),
      ),
    ).toBe(result.worktree_path);
  });

  test("switches only the active conversation cwd", async () => {
    const repo = await trackRepo();
    const fakeHome = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-home-"),
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
        const toolResult = await enter_worktree({
          name: "Conversation A Feature",
          refresh_base: false,
        });
        if (!toolResult.worktree_path) {
          throw new Error("Expected EnterWorktree to return a worktree path");
        }
        expect(getCurrentWorkingDirectory()).toBe(toolResult.worktree_path);
        return toolResult;
      },
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
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

  test("switches the current session cwd outside listener mode", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const result = await runWithRuntimeContext(
      { workingDirectory: repo },
      async () => {
        const toolResult = await enter_worktree({
          name: "Plain CLI Feature",
          refresh_base: false,
        });
        if (!toolResult.worktree_path) {
          throw new Error("Expected EnterWorktree to return a worktree path");
        }
        expect(getCurrentWorkingDirectory()).toBe(toolResult.worktree_path);
        return toolResult;
      },
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(result.switched_cwd).toBe(true);
    expect(process.cwd()).toBe(result.worktree_path);
    expect(process.env.USER_CWD).toBe(result.worktree_path);
    expect(result.content[0]?.text).toContain(
      "This conversation's working directory is now the new worktree.",
    );
  });

  test("updates the active tool context so same-turn tools use the new cwd", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);
    await loadSpecificTools(["EnterWorktree", "Bash"]);

    const prepared = await runWithRuntimeContext(
      { workingDirectory: repo },
      () => prepareCurrentToolExecutionContext({ workingDirectory: repo }),
    );

    try {
      const createResult = await executeTool(
        "EnterWorktree",
        { name: "Same Turn Feature", refresh_base: false },
        { toolContextId: prepared.contextId },
      );
      expect(createResult.status).toBe("success");
      const createdText = toolReturnText(createResult.toolReturn);
      const worktreePath = createdText.match(/^Path: (.+)$/m)?.[1];
      if (!worktreePath) {
        throw new Error(
          `Expected worktree path in tool return: ${createdText}`,
        );
      }

      const pwdResult = await executeTool(
        "Bash",
        { command: 'node -e "console.log(process.cwd())"' },
        { toolContextId: prepared.contextId },
      );

      expect(pwdResult.status).toBe("success");
      expect(toolReturnText(pwdResult.toolReturn).trim()).toBe(worktreePath);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test("updates the active tool context in listener mode so same-turn tools use the new cwd", async () => {
    const repo = await trackRepo();
    const listener = __listenClientTestUtils.createListenerRuntime();
    listener.bootWorkingDirectory = repo;
    __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-a",
    );
    setActiveRuntime(listener);
    await loadSpecificTools(["EnterWorktree", "Bash"]);

    const scope = {
      agentId: "agent-1",
      conversationId: "conv-a",
      workingDirectory: repo,
    };
    const prepared = await runWithRuntimeContext(scope, () =>
      prepareCurrentToolExecutionContext({ workingDirectory: repo }),
    );

    try {
      const createResult = await runWithRuntimeContext(scope, () =>
        executeTool(
          "EnterWorktree",
          { name: "Listener Same Turn Feature", refresh_base: false },
          { toolContextId: prepared.contextId },
        ),
      );
      expect(createResult.status).toBe("success");
      const createdText = toolReturnText(createResult.toolReturn);
      const worktreePath = createdText.match(/^Path: (.+)$/m)?.[1];
      if (!worktreePath) {
        throw new Error(
          `Expected worktree path in tool return: ${createdText}`,
        );
      }
      expect(
        __listenClientTestUtils.getConversationWorkingDirectory(
          listener,
          "agent-1",
          "conv-a",
        ),
      ).toBe(worktreePath);

      // The regression under test: subsequent tool calls in the SAME turn
      // resolve their cwd from the prepared execution context, which the
      // listener branch previously never updated.
      const pwdResult = await executeTool(
        "Bash",
        { command: 'node -e "console.log(process.cwd())"' },
        { toolContextId: prepared.contextId },
      );

      expect(pwdResult.status).toBe("success");
      expect(toolReturnText(pwdResult.toolReturn).trim()).toBe(worktreePath);
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test("fetches the remote default branch before creating the worktree", async () => {
    const repo = await trackRepo();
    const remote = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-remote-"),
    );
    const otherClone = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-clone-"),
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
      enter_worktree({
        name: "Latest Remote",
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(result.base_ref).toBe("origin/main");
    const remoteFile = await readFile(
      path.join(result.worktree_path, "REMOTE.md"),
      "utf8",
    );
    expect(remoteFile.replace(/\r\n/g, "\n")).toBe("latest remote\n");
  });

  test("creates a worktree from repo_path when current cwd is outside a git repository", async () => {
    const repo = await trackRepo();
    const dir = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-empty-"),
    );
    tempDirs.push(dir);

    const result = await runWithRuntimeContext({ workingDirectory: dir }, () =>
      enter_worktree({
        name: "Repo Path Feature",
        repo_path: repo,
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    expect(result.worktree_path).toBe(
      path.join(repo, ".letta", "worktrees", "repo-path-feature"),
    );
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(
      path.normalize(
        git(["rev-parse", "--show-toplevel"], result.worktree_path),
      ),
    ).toBe(result.worktree_path);
  });

  test("returns an error outside a git repository", async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-empty-"),
    );
    tempDirs.push(dir);

    const result = await runWithRuntimeContext({ workingDirectory: dir }, () =>
      enter_worktree({ name: "No Repo", refresh_base: false }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain(
      "Current working directory is not inside a git repository",
    );
    expect(result.content[0]?.text).toContain("repo_path");
  });

  test("symlinks node_modules from the primary checkout when symlink_dependencies is true", async () => {
    const repo = await trackRepo();
    await mkdir(path.join(repo, "node_modules", "left-pad"), {
      recursive: true,
    });
    await writeFile(
      path.join(repo, "node_modules", "left-pad", "index.js"),
      "module.exports = 1;\n",
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "symlink-deps",
        refresh_base: false,
        switch_cwd: false,
        symlink_dependencies: true,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    const linkPath = path.join(result.worktree_path, "node_modules");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(
      await readFile(path.join(linkPath, "left-pad", "index.js"), "utf8"),
    ).toContain("module.exports");
    expect(result.content[0]?.text).toContain("symlinked node_modules");
  });

  test("does not symlink dependencies by default (opt-in)", async () => {
    const repo = await trackRepo();
    await mkdir(path.join(repo, "node_modules", "left-pad"), {
      recursive: true,
    });
    await writeFile(
      path.join(repo, "node_modules", "left-pad", "index.js"),
      "module.exports = 1;\n",
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "isolated-deps",
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    // node_modules must not be present (neither symlinked nor copied).
    const linked = await lstat(
      path.join(result.worktree_path, "node_modules"),
    ).catch(() => null);
    expect(linked).toBeNull();
    expect(result.content[0]?.text).toContain(
      "Dependencies were not symlinked",
    );
  });

  test("copies gitignored files listed in .worktreeinclude (e.g. .env)", async () => {
    const repo = await trackRepo();
    await writeFile(path.join(repo, ".env"), "SECRET=abc123\n");
    await writeFile(
      path.join(repo, ".worktreeinclude"),
      "# secrets the worktree needs\n.env\n",
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "include-env",
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(
      await readFile(path.join(result.worktree_path, ".env"), "utf8"),
    ).toBe("SECRET=abc123\n");
    expect(result.content[0]?.text).toContain("via .worktreeinclude");
  });

  test("copies .letta/settings.local.json into the worktree", async () => {
    const repo = await trackRepo();
    await mkdir(path.join(repo, ".letta"), { recursive: true });
    await writeFile(
      path.join(repo, ".letta", "settings.local.json"),
      JSON.stringify({ lastAgent: null }),
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "copy-local-settings",
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    expect(
      await readFile(
        path.join(result.worktree_path, ".letta", "settings.local.json"),
        "utf8",
      ),
    ).toContain("lastAgent");
    expect(result.content[0]?.text).toContain(
      "copied .letta/settings.local.json",
    );
  });

  test("wires git hooks by symlinking a relative core.hooksPath directory", async () => {
    const repo = await trackRepo();
    git(["config", "core.hooksPath", ".husky/_"], repo);
    await mkdir(path.join(repo, ".husky", "_"), { recursive: true });
    await writeFile(
      path.join(repo, ".husky", "_", "pre-commit"),
      "#!/bin/sh\nexit 0\n",
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "wire-hooks",
        refresh_base: false,
        switch_cwd: false,
      }),
    );

    expect(result.status).toBe("success");
    if (!result.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    const hooksDir = path.join(result.worktree_path, ".husky", "_");
    expect((await lstat(hooksDir)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(hooksDir, "pre-commit"), "utf8")).toContain(
      "exit 0",
    );
    expect(result.content[0]?.text).toContain("wired git hooks");
  });

  test("switches into an existing managed worktree via path", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const created = await runWithRuntimeContext(
      { workingDirectory: repo },
      () =>
        enter_worktree({
          name: "Existing Feature",
          refresh_base: false,
          switch_cwd: false,
        }),
    );
    expect(created.status).toBe("success");
    if (!created.worktree_path) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }

    const entered = await runWithRuntimeContext(
      { workingDirectory: repo },
      () => enter_worktree({ path: created.worktree_path }),
    );

    expect(entered.status).toBe("success");
    expect(entered.switched_cwd).toBe(true);
    expect(entered.worktree_path).toBe(created.worktree_path);
    expect(entered.branch_name).toBe(created.branch_name);
    expect(process.cwd()).toBe(created.worktree_path);
    expect(entered.content[0]?.text).toContain("Switched to existing worktree");
  });

  test("refuses to enter a worktree outside .letta/worktrees", async () => {
    const repo = await trackRepo();
    const external = await mkdtemp(
      path.join(tmpdir(), "letta-enter-worktree-external-"),
    );
    tempDirs.push(external);
    const externalWorktree = path.join(external, "wt");
    git(
      [
        "worktree",
        "add",
        "--no-track",
        "-b",
        "external-branch",
        externalWorktree,
        "HEAD",
      ],
      repo,
    );

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({ path: externalWorktree }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("only worktrees under");
  });

  test("refuses to enter an unregistered directory under .letta/worktrees", async () => {
    const repo = await trackRepo();
    const ghost = path.join(repo, ".letta", "worktrees", "ghost");
    await mkdir(ghost, { recursive: true });

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({ path: ghost }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("not a registered worktree");
  });

  test("rejects combining path with name", async () => {
    const repo = await trackRepo();

    const result = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({ path: repo, name: "nope" }),
    );

    expect(result.status).toBe("error");
    expect(result.content[0]?.text).toContain("cannot be combined");
  });

  test("blocks a second agent from entering a worktree another agent holds", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const created = await runWithRuntimeContext(
      { workingDirectory: repo },
      () =>
        enter_worktree({
          name: "Shared Worktree",
          refresh_base: false,
          switch_cwd: false,
        }),
    );
    expect(created.status).toBe("success");
    const worktree = created.worktree_path;
    if (!worktree) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }

    const first = await runWithRuntimeContext(
      { agentId: "agent-1", conversationId: "conv-a", workingDirectory: repo },
      () => enter_worktree({ path: worktree }),
    );
    expect(first.status).toBe("success");
    expect(first.content[0]?.text).toContain("Lock:");

    const blocked = await runWithRuntimeContext(
      { agentId: "agent-2", conversationId: "conv-b", workingDirectory: repo },
      () => enter_worktree({ path: worktree }),
    );
    expect(blocked.status).toBe("error");
    expect(blocked.content[0]?.text).toContain("in use by another agent");
    expect(blocked.content[0]?.text).toContain("force: true");

    const forced = await runWithRuntimeContext(
      { agentId: "agent-2", conversationId: "conv-b", workingDirectory: repo },
      () => enter_worktree({ path: worktree, force: true }),
    );
    expect(forced.status).toBe("success");
    expect(forced.content[0]?.text).toContain("force-claimed");
  });

  test("lets the same conversation re-enter a worktree it already holds", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const created = await runWithRuntimeContext(
      { workingDirectory: repo },
      () =>
        enter_worktree({
          name: "Reenter Worktree",
          refresh_base: false,
          switch_cwd: false,
        }),
    );
    const worktree = created.worktree_path;
    if (!worktree) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }

    const first = await runWithRuntimeContext(
      { conversationId: "conv-a", workingDirectory: repo },
      () => enter_worktree({ path: worktree }),
    );
    expect(first.status).toBe("success");

    const again = await runWithRuntimeContext(
      { conversationId: "conv-a", workingDirectory: worktree },
      () => enter_worktree({ path: worktree }),
    );
    expect(again.status).toBe("success");
  });

  test("releases the lock when a conversation switches to another worktree", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const one = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "Worktree One",
        refresh_base: false,
        switch_cwd: false,
      }),
    );
    const two = await runWithRuntimeContext({ workingDirectory: repo }, () =>
      enter_worktree({
        name: "Worktree Two",
        refresh_base: false,
        switch_cwd: false,
      }),
    );
    const pathOne = one.worktree_path;
    const pathTwo = two.worktree_path;
    if (!pathOne || !pathTwo) {
      throw new Error("Expected EnterWorktree to return worktree paths");
    }

    // conv-a takes worktree one, then moves to worktree two (releasing one).
    await runWithRuntimeContext(
      { conversationId: "conv-a", workingDirectory: repo },
      () => enter_worktree({ path: pathOne }),
    );
    await runWithRuntimeContext(
      { conversationId: "conv-a", workingDirectory: pathOne },
      () => enter_worktree({ path: pathTwo }),
    );

    // conv-b can now take worktree one because conv-a's lock there was freed.
    const reused = await runWithRuntimeContext(
      { conversationId: "conv-b", workingDirectory: repo },
      () => enter_worktree({ path: pathOne }),
    );
    expect(reused.status).toBe("success");
  });

  test("reclaims a stale lock left by a dead process and supports release", async () => {
    const repo = await trackRepo();
    setActiveRuntime(null);

    const created = await runWithRuntimeContext(
      { workingDirectory: repo },
      () =>
        enter_worktree({
          name: "Stale Worktree",
          refresh_base: false,
          switch_cwd: false,
        }),
    );
    const worktree = created.worktree_path;
    if (!worktree) {
      throw new Error("Expected EnterWorktree to return a worktree path");
    }
    const gitDir = git(["rev-parse", "--absolute-git-dir"], worktree);

    // A lock left by a process that no longer exists. 999999 is above the
    // default max pid on the platforms this runs on, so it is never live.
    await writeFile(
      path.join(gitDir, "letta-enter.lock"),
      JSON.stringify({
        conversationId: "ghost-conv",
        agentId: null,
        pid: 999999,
        hostname: hostname(),
        acquiredAt: "2020-01-01T00:00:00.000Z",
      }),
    );

    const owner = { conversationId: "live-conv", agentId: "agent-1" };
    const reclaimed = await acquireWorktreeLock({
      worktreeGitDir: gitDir,
      owner,
    });
    expect(reclaimed.outcome).toBe("reclaimed");

    const reentrant = await acquireWorktreeLock({
      worktreeGitDir: gitDir,
      owner,
    });
    expect(reentrant.outcome).toBe("reentrant");

    expect(await releaseWorktreeLock({ worktreeGitDir: gitDir, owner })).toBe(
      true,
    );
    expect(await releaseWorktreeLock({ worktreeGitDir: gitDir, owner })).toBe(
      false,
    );
  });

  test("adds a windows path-length hint to git checkout failures", () => {
    const message = addWindowsPathLengthHint(
      "Failed to run git worktree add\nerror: unable to create file: filename too long\nfatal: could not reset index file to revision 'HEAD'",
      "win32",
    );

    expect(message).toContain("Windows path-length issue");
    expect(message).toContain("core.longpaths");
    expect(message).toContain("C:\\src\\<repo>");
  });

  test("does not add the hint off windows", () => {
    const message = addWindowsPathLengthHint(
      "Failed to run git worktree add\nerror: unable to create file: filename too long",
      "linux",
    );

    expect(message).not.toContain("Windows path-length issue");
  });
});
