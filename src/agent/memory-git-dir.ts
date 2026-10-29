import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

/**
 * Canonical path of a checkout's Git directory. Worktrees have their own, so
 * state kept here (locks, repair attempts, operation heads) stays independent
 * of the worktrees that share the repository.
 */
export async function getMemoryGitDir(memoryDir: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    "rev-parse",
    "--git-dir",
  ]);
  return realpath(resolve(memoryDir, stdout.trim() || ".git"));
}
