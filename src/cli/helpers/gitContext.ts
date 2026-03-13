import { execFileSync } from "node:child_process";

export interface GitContextSnapshot {
  isGitRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  mainBranch: string | null;
  upstream: string | null;
  aheadCount: number | null;
  behindCount: number | null;
  status: string | null;
  recentCommits: string | null;
  recentContributors: string[] | null;
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
  contributorLimit?: number;
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
    `\n... and ${lines.length - maxLines} more files`
  );
}

function parseAheadBehind(value: string | null): {
  aheadCount: number | null;
  behindCount: number | null;
} {
  if (!value) {
    return { aheadCount: null, behindCount: null };
  }

  const [behindRaw, aheadRaw] = value.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return { aheadCount: null, behindCount: null };
  }

  return { aheadCount: ahead, behindCount: behind };
}

function parseContributors(
  value: string | null,
  maxContributors: number,
): string[] {
  if (!value) {
    return [];
  }

  const contributors: string[] = [];
  for (const line of value.split("\n")) {
    const match = line.match(/^\s*\d+\s+(.+)$/);
    if (!match?.[1]) continue;
    contributors.push(match[1].trim());
    if (contributors.length >= maxContributors) {
      break;
    }
  }
  return contributors;
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
  const contributorLimit = options.contributorLimit ?? 3;

  if (!runGit(["rev-parse", "--git-dir"], cwd)) {
    return {
      isGitRepo: false,
      repoRoot: null,
      branch: null,
      head: null,
      mainBranch: null,
      upstream: null,
      aheadCount: null,
      behindCount: null,
      status: null,
      recentCommits: null,
      recentContributors: null,
      gitUser: null,
    };
  }

  const repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
  const branch = runGit(["branch", "--show-current"], cwd);
  const head = runGit(["show", "-s", "--format=%h %s", "HEAD"], cwd);
  const originHead = runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    cwd,
  );
  const upstream = runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
  );
  const aheadBehindRaw = upstream
    ? runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"], cwd)
    : null;
  const { aheadCount, behindCount } = parseAheadBehind(aheadBehindRaw);
  const mainBranch = originHead?.startsWith("origin/")
    ? originHead.slice("origin/".length)
    : (originHead ?? "main");

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
  const contributorsRaw = runGit(["shortlog", "-sn", "-n", "-20", "HEAD"], cwd);
  const recentContributors = parseContributors(
    contributorsRaw,
    contributorLimit,
  );

  const userName = runGit(["config", "user.name"], cwd);
  const userEmail = runGit(["config", "user.email"], cwd);
  const gitUser = formatGitUser(userName, userEmail);

  return {
    isGitRepo: true,
    repoRoot,
    branch,
    head,
    mainBranch,
    upstream,
    aheadCount,
    behindCount,
    status,
    recentCommits,
    recentContributors:
      recentContributors.length > 0 ? recentContributors : null,
    gitUser,
  };
}
