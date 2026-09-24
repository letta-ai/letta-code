import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempGitRepo {
  dir: string;
  /** Run git in the repository and return trimmed stdout. */
  git: (...args: string[]) => string;
  cleanup: () => void;
}

/**
 * Initialize `dir` as a repository on `main` with deterministic identity,
 * signing and line-ending settings, so tests behave the same on every
 * developer machine and CI runner. `cleanup` removes the directory.
 */
export function initGitRepo(dir: string): TempGitRepo {
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Letta Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.eol", "lf");
  return {
    dir,
    git,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A throwaway repository in a fresh temporary directory. */
export function createTempGitRepo(prefix = "letta-test-repo-"): TempGitRepo {
  return initGitRepo(mkdtempSync(join(tmpdir(), prefix)));
}
