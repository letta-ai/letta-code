import { execFileSync } from "node:child_process";

export interface GitContextSnapshot {
  isGitRepo: boolean;
  branch: string | null;
  status: string | null;
  recentCommits: string | null;
  gitUser: string | null;
}

export interface GatherGitContextOptions {
  cwd?: string;
  recentCommitLimit?: number;
  /**
   * Git log format string passed to `git log --format=...`.
   * If omitted, uses `git log --oneline`.
   */
  recentCommitFormat?: string;
  statusLineLimit?: number;
}

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

function truncateLines(value: string, maxLines: number): string {
  const lines = value.split("\n");
  if (lines.length <= maxLines) {
    return value;
  }
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n... and ${lines.length - maxLines} more changes`
  );
}

function formatGitUser(
  name: string | null,
  email: string | null,
): string | null {
  if (!name && !email) {
    return null;
  }
  if (name && email) {
    return `${name} <${email}>`;
  }
  return name || email;
}

export function gatherGitContextSnapshot(
  options: GatherGitContextOptions = {},
): GitContextSnapshot {
  const cwd = options.cwd ?? process.cwd();
  const recentCommitLimit = options.recentCommitLimit ?? 3;

  if (!runGit(["rev-parse", "--git-dir"], cwd)) {
    return {
      isGitRepo: false,
      branch: null,
      status: null,
      recentCommits: null,
      gitUser: null,
    };
  }

  const branch = runGit(["branch", "--show-current"], cwd);

  const fullStatus = runGit(["status", "--short"], cwd);
  const status =
    typeof fullStatus === "string" && options.statusLineLimit
      ? truncateLines(fullStatus, options.statusLineLimit)
      : fullStatus;

  const recentCommits = options.recentCommitFormat
    ? runGit(
        [
          "log",
          `--format=${options.recentCommitFormat}`,
          "-n",
          String(recentCommitLimit),
        ],
        cwd,
      )
    : runGit(["log", "--oneline", "-n", String(recentCommitLimit)], cwd);

  const userConfig = runGit(
    ["config", "--get-regexp", "^user\\.(name|email)$"],
    cwd,
  );
  let userName: string | null = null;
  let userEmail: string | null = null;
  if (userConfig) {
    for (const line of userConfig.split("\n")) {
      if (line.startsWith("user.name "))
        userName = line.slice("user.name ".length);
      else if (line.startsWith("user.email "))
        userEmail = line.slice("user.email ".length);
    }
  }
  const gitUser = formatGitUser(userName, userEmail);

  return {
    isGitRepo: true,
    branch,
    status,
    recentCommits,
    gitUser,
  };
}

// ─────────────────────────────────────────────────
//  Lightweight git context for DeviceStatus
// ─────────────────────────────────────────────────

export interface LightGitContext {
  branch: string | null;
  recent_branches: string[];
}

/**
 * Get a lightweight git context suitable for the DeviceStatus payload.
 * Fast: only runs `git branch --show-current` and `git branch --sort=-committerdate`.
 * Returns null if the cwd is not inside a git repo.
 */
export function getGitContext(cwd: string): LightGitContext | null {
  if (!runGit(["rev-parse", "--git-dir"], cwd)) {
    return null;
  }

  const branch = runGit(["branch", "--show-current"], cwd);

  // Get up to 11 local branches sorted by most recent commit (10 + current)
  const branchList = runGit(
    [
      "branch",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "--no-color",
    ],
    cwd,
  );

  const recentBranches = branchList
    ? branchList
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b.length > 0 && b !== branch)
        .slice(0, 10)
    : [];

  return { branch, recent_branches: recentBranches };
}
