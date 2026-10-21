import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addWorktreeSafely,
  buildNonInteractiveGitEnv,
  formatGitFailure,
  runGit,
} from "@/tools/impl/worktree-git";

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

async function createRepo(tempDirs: string[]): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "letta-worktree-safe-add-"));
  tempDirs.push(repo);
  git(["init", "-b", "main"], repo);
  // Windows runners enable core.autocrlf, which would check the payload out
  // with CRLF and break the exact-bytes assertions.
  git(["config", "core.autocrlf", "false"], repo);
  await writeFile(
    path.join(repo, ".gitattributes"),
    "payload filter=watcher\n",
  );
  await writeFile(path.join(repo, "payload"), "content\n");
  git(["add", ".gitattributes", "payload"], repo);
  git(["commit", "-m", "initial commit"], repo);
  return repo;
}

function addWorktree(repo: string, name: string): Promise<void> {
  return addWorktreeSafely({
    repoRoot: repo,
    branchName: name,
    worktreePath: path.join(repo, name),
    baseRef: "main",
  });
}

function readPayload(repo: string, name: string): string {
  return readFileSync(path.join(repo, name, "payload"), "utf8");
}

async function installHangingGit(
  tempDirs: string[],
  originalPath: string | undefined,
): Promise<string> {
  const binDir = await mkdtemp(path.join(tmpdir(), "letta-worktree-git-test-"));
  tempDirs.push(binDir);
  const fakeGit = path.join(binDir, "git");
  const descendantScript = "setInterval(() => {}, 1000);";
  const gitScript = [
    "#!/usr/bin/env node",
    'const { spawn } = require("node:child_process");',
    `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "inherit" });`,
    'process.stdout.write("descendant:" + descendant.pid + "\\n");',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await writeFile(fakeGit, gitScript);
  await chmod(fakeGit, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  return binDir;
}

function isProcessStillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(")");
    const state =
      endCommand === -1 ? "" : stat.slice(endCommand + 2, endCommand + 3);
    // kill(pid, 0) still succeeds after exit while Linux waits to reap a zombie.
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

async function expectGitDescendantExited(failure: string): Promise<void> {
  const descendantPid = Number(failure.match(/descendant:(\d+)/)?.[1]);
  expect(descendantPid).toBeGreaterThan(0);
  const deadline = Date.now() + 1000;
  while (isProcessStillRunning(descendantPid) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(isProcessStillRunning(descendantPid)).toBe(false);
}

describe("worktree Git runner", () => {
  const originalPath = process.env.PATH;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("disables Git, credential-manager, askpass, and SSH prompts", () => {
    const env = buildNonInteractiveGitEnv({
      PATH: "/usr/bin",
      GIT_SSH_COMMAND: "ssh -F custom.conf",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GCM_INTERACTIVE).toBe("never");
    expect(env.GIT_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS).toBe("");
    expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(env.GIT_SSH_COMMAND).toBe("ssh -F custom.conf -o BatchMode=yes");
    expect(buildNonInteractiveGitEnv({}).GIT_SSH_COMMAND).toBe(
      "ssh -o BatchMode=yes",
    );
  });

  test.each([
    ["repository-local", []],
    // `git worktree add` copies config.worktree into the new worktree before
    // checkout, and `git config --local` never reads that file.
    ["worktree-scoped", ["--worktree"]],
  ])("neutralizes %s checkout filters", async (_label, scope) => {
    const repo = await createRepo(tempDirs);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    // A failing required smudge filter fails a plain `git worktree add`.
    git(["config", ...scope, "filter.watcher.smudge", "false"], repo);
    git(["config", ...scope, "filter.watcher.required", "true"], repo);

    await addWorktree(repo, "safe-filter");

    expect(readPayload(repo, "safe-filter")).toBe("content\n");
  });

  test.each([
    [
      ["lfs.customtransfer.watcher.path", "/tmp/watcher"],
      "repository's own git config sets lfs.customtransfer.watcher.path",
    ],
    [
      ["lfs.standalonetransferagent", "watcher"],
      "repository's own git config sets lfs.standalonetransferagent",
    ],
    [
      ["--worktree", "lfs.standalonetransferagent", "watcher"],
      "repository's own git config sets lfs.standalonetransferagent",
    ],
    [
      ["includeIf.gitdir:/tmp/letta-worktree/.path", "/tmp/letta-worktree-cfg"],
      "conditional include (includeIf)",
    ],
    [["filter.bad=name.smudge", "false"], "name cannot be neutralized"],
  ])("rejects git config %j", async (configArgs, message) => {
    const repo = await createRepo(tempDirs);
    git(["config", "extensions.worktreeConfig", "true"], repo);
    git(["config", ...configArgs], repo);

    await expect(addWorktree(repo, "blocked")).rejects.toThrow(message);
  });

  test("adds further worktrees when worktree-scoped config is disabled", async () => {
    const repo = await createRepo(tempDirs);
    // `git config --worktree` dies in a multi-worktree repository unless
    // extensions.worktreeConfig is on, so the scan must not rely on it.
    await addWorktree(repo, "first");
    await addWorktree(repo, "second");

    expect(readPayload(repo, "second")).toBe("content\n");
  });

  test("does not run repository hooks", async () => {
    const repo = await createRepo(tempDirs);
    // A failing post-checkout hook fails a plain `git worktree add`.
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    await addWorktree(repo, "safe-hooks");

    expect(readPayload(repo, "safe-hooks")).toBe("content\n");
  });

  test.skipIf(process.platform === "win32")(
    "does not run a repository-local fsmonitor command",
    async () => {
      const repo = await createRepo(tempDirs);
      const scriptDir = await mkdtemp(
        path.join(tmpdir(), "letta-worktree-fsmonitor-"),
      );
      tempDirs.push(scriptDir);
      const script = path.join(scriptDir, "fsmonitor");
      await writeFile(script, '#!/bin/sh\ntouch "$(dirname "$0")/ran"\n');
      await chmod(script, 0o755);
      git(["config", "core.fsmonitor", script], repo);

      await addWorktree(repo, "safe-fsmonitor");

      expect(existsSync(path.join(scriptDir, "ran"))).toBe(false);
    },
  );

  test.skipIf(process.platform === "win32")(
    "kills Git descendants when an internal command times out",
    async () => {
      const binDir = await installHangingGit(tempDirs, originalPath);

      const startedAt = Date.now();
      let failure = "";
      try {
        await runGit(["fetch"], binDir, { timeoutMs: 500 });
      } catch (error) {
        failure = formatGitFailure(error);
      }

      expect(failure).toContain("Timed out running git fetch");
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await expectGitDescendantExited(failure);
    },
  );

  test.skipIf(process.platform === "win32")(
    "kills Git descendants when the worktree tool is interrupted",
    async () => {
      const binDir = await installHangingGit(tempDirs, originalPath);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 500);
      const startedAt = Date.now();
      let failure = "";
      try {
        await runGit(["fetch"], binDir, {
          signal: controller.signal,
          timeoutMs: 10_000,
        });
      } catch (error) {
        failure = formatGitFailure(error);
      } finally {
        clearTimeout(abortTimer);
      }

      expect(failure).toContain(
        "Failed to run git fetch: The operation was aborted",
      );
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await expectGitDescendantExited(failure);
    },
  );
});
