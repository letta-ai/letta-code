/**
 * Tests for the git post-commit hook that pushes memfs commits to an
 * additional git remote configured via `letta.memoryRepository.url`.
 *
 * Strategy:
 *   - Create a temp "source" git repo (acts as the memfs repo).
 *   - Create a temp bare repo (acts as the user's private GitHub repo).
 *   - Install the post-commit hook + set letta.memoryRepository.url to the
 *     bare repo.
 *   - Commit to source, wait briefly for the async push, verify the bare repo
 *     receives the same HEAD SHA.
 *
 * The TS-side pushToMemoryRepository helper resolves agent memory under the
 * real OS home directory, so detached handling there is covered by code review.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST_COMMIT_HOOK_SCRIPT } from "../../agent/memoryGit";

let sourceDir: string;
let remoteDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    env: GIT_ENV,
  });
}

function gitQuiet(cwd: string, args: string): string {
  return execSync(`git ${args}`, {
    cwd,
    encoding: "utf-8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function installHook(dir: string): void {
  const hookPath = join(dir, ".git", "hooks", "post-commit");
  writeFileSync(hookPath, POST_COMMIT_HOOK_SCRIPT, "utf-8");
  chmodSync(hookPath, 0o755);
}

beforeEach(() => {
  // Source repo (memfs-style)
  sourceDir = mkdtempSync(join(tmpdir(), "memgit-post-src-"));
  git(sourceDir, "init -b main");
  writeFileSync(join(sourceDir, ".gitkeep"), "");
  git(sourceDir, "add .gitkeep");
  git(sourceDir, 'commit -m "init"');

  // Remote (bare) — simulates a private GitHub repo
  remoteDir = mkdtempSync(join(tmpdir(), "memgit-post-remote-"));
  git(remoteDir, "init --bare -b main");

  installHook(sourceDir);
});

afterEach(() => {
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(remoteDir, { recursive: true, force: true });
});

const LOG_FILE = "memory-repository-push.log";

describe("post-commit memory-repository hook", () => {
  test("no-ops when letta.memoryRepository.url is unset", async () => {
    writeFileSync(join(sourceDir, "note.txt"), "hello");
    git(sourceDir, "add note.txt");
    git(sourceDir, 'commit -m "add note"');

    // Wait a moment for any async work, then assert no log file got created.
    await sleep(250);
    const logPath = join(sourceDir, ".git", LOG_FILE);
    expect(existsSync(logPath)).toBe(false);
  });

  test("pushes to configured memory-repository URL after commit", async () => {
    git(sourceDir, `config --local letta.memoryRepository.url ${remoteDir}`);

    writeFileSync(join(sourceDir, "note.txt"), "hello remote");
    git(sourceDir, "add note.txt");
    git(sourceDir, 'commit -m "add note"');
    const sourceSha = git(sourceDir, "rev-parse HEAD").trim();

    // Hook pushes async — poll until the remote has the same HEAD.
    const pushed = await waitUntil(() => {
      try {
        const remoteSha = gitQuiet(remoteDir, "rev-parse main").trim();
        return remoteSha === sourceSha;
      } catch {
        return false;
      }
    });
    expect(pushed).toBe(true);

    // Log file should have exit=0 for the successful push.
    const logPath = join(sourceDir, ".git", LOG_FILE);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("exit=0");
  });

  test("logs failures when push target is unreachable", async () => {
    git(
      sourceDir,
      `config --local letta.memoryRepository.url ${join(tmpdir(), "does-not-exist-bare-repo.git")}`,
    );

    writeFileSync(join(sourceDir, "note.txt"), "will fail");
    git(sourceDir, "add note.txt");
    git(sourceDir, 'commit -m "fail push"');

    const logPath = join(sourceDir, ".git", LOG_FILE);
    const completed = await waitUntil(() => {
      if (!existsSync(logPath)) return false;
      const log = readFileSync(logPath, "utf-8");
      return /^exit=\d+/m.test(log);
    });
    expect(completed).toBe(true);

    const log = readFileSync(logPath, "utf-8");
    // Failure is a non-zero exit code.
    expect(log).toMatch(/exit=(?!0$)\d+/m);
  });

  test("does not block the commit when hook fails", async () => {
    git(
      sourceDir,
      `config --local letta.memoryRepository.url ${join(tmpdir(), "also-does-not-exist.git")}`,
    );

    // The commit itself should still succeed even though the push fails.
    writeFileSync(join(sourceDir, "note.txt"), "still works");
    git(sourceDir, "add note.txt");
    const output = git(sourceDir, 'commit -m "ok even on push fail"');
    expect(output).toContain("ok even on push fail");

    const sha = git(sourceDir, "rev-parse HEAD").trim();
    expect(sha.length).toBe(40);
  });

  test("no-ops when HEAD is detached", async () => {
    git(sourceDir, `config --local letta.memoryRepository.url ${remoteDir}`);
    gitQuiet(sourceDir, "checkout --detach HEAD");
    git(sourceDir, 'commit --allow-empty -m "detached noop"');

    const logPath = join(sourceDir, ".git", LOG_FILE);
    expect(existsSync(logPath)).toBe(false);

    let remoteHasMain = true;
    try {
      gitQuiet(remoteDir, "rev-parse main");
    } catch {
      remoteHasMain = false;
    }
    expect(remoteHasMain).toBe(false);
  });
});
