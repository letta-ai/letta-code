import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

// A git child that never exits (lock contention, a stalled network filesystem,
// a credential prompt) would otherwise hang every caller sharing its promise,
// including listener startup.
const GIT_ASYNC_TIMEOUT_MS = 10_000;

async function runGitAsync(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf-8",
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    return stdout.trim();
  } catch (error) {
    // Node sets `killed` when it killed the child for exceeding the timeout.
    // An ordinary non-zero git exit still means "no value".
    if ((error as { killed?: boolean } | null)?.killed) {
      throw new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`);
    }
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
 * Returns null if the cwd is not inside a git repo. Rejects (after killing the
 * child) if any git command runs longer than `timeoutMs`.
 */
export async function getGitContextAsync(
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<LightGitContext | null> {
  const timeoutMs = options.timeoutMs ?? GIT_ASYNC_TIMEOUT_MS;
  if (!(await runGitAsync(["rev-parse", "--git-dir"], cwd, timeoutMs))) {
    return null;
  }

  const branch = await runGitAsync(
    ["branch", "--show-current"],
    cwd,
    timeoutMs,
  );

  // Get up to 11 local branches sorted by most recent commit (10 + current)
  const branchList = await runGitAsync(
    [
      "branch",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "--no-color",
    ],
    cwd,
    timeoutMs,
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
