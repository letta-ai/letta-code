import { execFileSync } from "node:child_process";

export interface GitStatusSummary {
  staged: number;
  unstaged: number;
  untracked: number;
  total: number;
}

export interface GitContextSnapshot {
  isGitRepo: boolean;
  branch: string | null;
  status: string | null;
  statusSummary: GitStatusSummary | null;
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

/**
 * Parse `git status --short` output. Each line has the format `XY path`
 * where X is the index (staged) state and Y is the worktree (unstaged) state.
 * `??` marks untracked files. A space means no change in that column.
 */
function summarizeStatus(status: string | null): GitStatusSummary | null {
  if (!status) {
    return null;
  }

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of status.split("\n")) {
    if (!line) continue;

    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }

    const indexState = line[0];
    const worktreeState = line[1];
    if (indexState && indexState !== " " && indexState !== "?") {
      staged += 1;
    }
    if (worktreeState && worktreeState !== " " && worktreeState !== "?") {
      unstaged += 1;
    }
  }

  return {
    staged,
    unstaged,
    untracked,
    total: staged + unstaged + untracked,
  };
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
      statusSummary: null,
      recentCommits: null,
      gitUser: null,
    };
  }

  const branch = runGit(["branch", "--show-current"], cwd);

  const fullStatus = runGit(["status", "--short"], cwd);
  const statusSummary = summarizeStatus(fullStatus);
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
    statusSummary,
    recentCommits,
    gitUser,
  };
}
