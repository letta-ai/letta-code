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
 * A throwaway repository on `main` with deterministic identity, signing and
 * line-ending settings, so tests behave the same on every developer machine
 * and CI runner.
 */
export function createTempGitRepo(prefix = "letta-test-repo-"): TempGitRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
