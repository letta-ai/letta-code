/**
 * Git context and operations for the listener runtime.
 *
 * All operations run synchronously via execFileSync and are scoped to the
 * conversation's current working directory (not process.cwd()).
 */

import { execFileSync } from "node:child_process";
import type { GitContext, GitOp } from "../../types/protocol_v2";

const MAX_RECENT_BRANCHES = 10;

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get git context (branch + recent branches) for the given directory.
 * Returns null if the directory is not a git repo or git is unavailable.
 */
export function getGitContext(cwd: string): GitContext | null {
  // Quick check: is this a git repo?
  if (!runGit(["rev-parse", "--git-dir"], cwd)) {
    return null;
  }

  const branch = runGit(["branch", "--show-current"], cwd) || null;

  // Get local branches sorted by most-recently-committed, excluding current.
  const recentBranches = getRecentBranches(cwd, branch);

  return { branch, recent_branches: recentBranches };
}

function getRecentBranches(
  cwd: string,
  currentBranch: string | null,
): string[] {
  const raw = runGit(
    [
      "branch",
      "--sort=-committerdate",
      "--format=%(refname:short)",
    ],
    cwd,
  );

  if (!raw) {
    return [];
  }

  return raw
    .split("\n")
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && b !== currentBranch)
    .slice(0, MAX_RECENT_BRANCHES);
}

/**
 * Search local branches by a substring pattern.
 * Returns all local branches sorted by most-recently-committed that match
 * the query. If query is empty, returns all local branches.
 */
export function searchBranches(query: string, cwd: string): string[] {
  const pattern = query.length > 0 ? `*${query}*` : '*';
  const raw = runGit(
    [
      'branch',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      '--list',
      pattern,
    ],
    cwd,
  );

  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

export interface GitOpResult {
  success: boolean;
  error?: string;
}

/**
 * Execute a git branch operation in the given directory.
 * - "checkout": git checkout <branch>
 * - "create_branch": git checkout -b <branch> (creates from HEAD and checks out)
 */
export function handleGitOp(op: GitOp, cwd: string): GitOpResult {
  try {
    if (op.kind === "checkout") {
      const result = execFileSync("git", ["checkout", op.branch], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      void result;
      return { success: true };
    }

    if (op.kind === "create_branch") {
      const result = execFileSync("git", ["checkout", "-b", op.branch], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      void result;
      return { success: true };
    }

    return { success: false, error: `Unknown git op kind` };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Git operation failed";
    // execFileSync throws with stderr in message — extract the useful part
    const stderr = (err as { stderr?: string }).stderr;
    return {
      success: false,
      error: stderr?.trim() || message,
    };
  }
}
