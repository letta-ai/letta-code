import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { ClaudeWatchStateSnapshot } from "./types.ts";

export const CLAUDE_WATCH_STATE_BRANCH = "claude-watch-state";
export const CLAUDE_WATCH_STATE_FILE = "snapshot.json";

export interface FinalizeStateBranchOptions {
  repoPath: string;
  snapshot: ClaudeWatchStateSnapshot;
  files?: Readonly<Record<string, string>>;
  expectedBaseSha: string | null;
  remote?: string;
  branch?: string;
  commitMessage?: string;
}

export interface FinalizeStateBranchResult {
  commitSha: string;
  created: boolean;
  parentSha: string | null;
}

export function materializeStateFiles(
  snapshot: ClaudeWatchStateSnapshot,
  files: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const path of Object.keys(files).sort()) {
    assertSafeStatePath(path);
    if (path === CLAUDE_WATCH_STATE_FILE) continue;
    result[path] = files[path] as string;
  }
  result[CLAUDE_WATCH_STATE_FILE] = `${JSON.stringify(snapshot, null, 2)}\n`;
  return result;
}

export function loadStateSnapshot(
  files: Readonly<Record<string, string>>,
): ClaudeWatchStateSnapshot | null {
  const source = files[CLAUDE_WATCH_STATE_FILE];
  if (typeof source !== "string") return null;
  try {
    const value: unknown = JSON.parse(source);
    return isStateSnapshot(value) ? value : null;
  } catch {
    return null;
  }
}

export function loadStateSnapshotAtCommit(
  repoPath: string,
  commitSha: string,
): ClaudeWatchStateSnapshot | null {
  const result = git(
    repoPath,
    ["show", `${commitSha}:${CLAUDE_WATCH_STATE_FILE}`],
    false,
  );
  if (!result.ok) return null;
  return loadStateSnapshot({ [CLAUDE_WATCH_STATE_FILE]: result.stdout });
}

export function loadStateFilesAtCommit(
  repoPath: string,
  commitSha: string,
): Record<string, string> {
  const listed = git(
    repoPath,
    ["ls-tree", "-r", "--name-only", commitSha],
    false,
  );
  if (!listed.ok) return {};
  const files: Record<string, string> = {};
  for (const path of listed.stdout.split("\n").filter(Boolean).sort()) {
    assertSafeStatePath(path);
    const contents = git(repoPath, ["show", `${commitSha}:${path}`], false);
    if (contents.ok) files[path] = contents.stdout;
  }
  return files;
}

export function resolveStateBranchTip(
  repoPath: string,
  remote = "origin",
  branch = CLAUDE_WATCH_STATE_BRANCH,
): string | null {
  assertBranchName(branch);
  const result = git(repoPath, [
    "ls-remote",
    "--heads",
    remote,
    `refs/heads/${branch}`,
  ]);
  const line = result.stdout.trim();
  if (!line) return null;
  const sha = line.split(/\s+/, 1)[0];
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`Unexpected state branch response for ${branch}`);
  }
  return sha;
}

export function fetchStateBranchTip(
  repoPath: string,
  remote = "origin",
  branch = CLAUDE_WATCH_STATE_BRANCH,
): string | null {
  const tip = resolveStateBranchTip(repoPath, remote, branch);
  if (!tip) return null;
  git(repoPath, [
    "fetch",
    "--no-tags",
    "--depth=2",
    remote,
    `refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
  ]);
  return tip;
}

export function finalizeStateBranch(
  options: FinalizeStateBranchOptions,
): FinalizeStateBranchResult {
  const remote = options.remote ?? "origin";
  const branch = options.branch ?? CLAUDE_WATCH_STATE_BRANCH;
  assertBranchName(branch);

  const currentTip = resolveStateBranchTip(options.repoPath, remote, branch);
  if (currentTip) fetchStateBranchTip(options.repoPath, remote, branch);
  const currentSnapshot = currentTip
    ? loadStateSnapshotAtCommit(options.repoPath, currentTip)
    : null;

  if (
    currentTip &&
    currentSnapshot?.candidate_id === options.snapshot.candidate_id
  ) {
    return { commitSha: currentTip, created: false, parentSha: currentTip };
  }

  if (currentTip !== options.expectedBaseSha) {
    throw new Error(
      `Claude state branch advanced: expected ${options.expectedBaseSha ?? "no branch"}, found ${currentTip ?? "no branch"}`,
    );
  }

  const snapshot: ClaudeWatchStateSnapshot = {
    ...options.snapshot,
    state_commit_parent: currentTip,
  };
  const files = materializeStateFiles(snapshot, options.files);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "claude-watch-state-"));
  const indexFile = join(temporaryDirectory, "index");
  const env = {
    ...process.env,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Claude Watch",
    GIT_AUTHOR_EMAIL:
      process.env.GIT_AUTHOR_EMAIL ?? "claude-watch@users.noreply.github.com",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Claude Watch",
    GIT_COMMITTER_EMAIL:
      process.env.GIT_COMMITTER_EMAIL ??
      "claude-watch@users.noreply.github.com",
  };

  try {
    git(options.repoPath, ["read-tree", "--empty"], true, env);
    for (const [path, contents] of Object.entries(files)) {
      const blob = git(
        options.repoPath,
        ["hash-object", "-w", "--stdin"],
        true,
        env,
        contents,
      ).stdout.trim();
      git(
        options.repoPath,
        ["update-index", "--add", "--cacheinfo", "100644", blob, path],
        true,
        env,
      );
    }
    const tree = git(options.repoPath, ["write-tree"], true, env).stdout.trim();
    const commitArgs = [
      "commit-tree",
      tree,
      ...(currentTip ? ["-p", currentTip] : []),
      "-m",
      options.commitMessage ??
        `chore(claude-watch): record ${snapshot.candidate_id}`,
    ];
    const commitSha = git(
      options.repoPath,
      commitArgs,
      true,
      env,
    ).stdout.trim();

    git(options.repoPath, [
      "push",
      remote,
      `${commitSha}:refs/heads/${branch}`,
    ]);
    return { commitSha, created: true, parentSha: currentTip };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

interface GitResult {
  ok: boolean;
  stdout: string;
}

function git(
  repoPath: string,
  args: string[],
  required = true,
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): GitResult {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    env,
    input,
  });
  const stdout = result.stdout ?? "";
  if (required && result.status !== 0) {
    const detail = (result.stderr ?? stdout).trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return { ok: result.status === 0, stdout };
}

function assertSafeStatePath(path: string): void {
  if (
    !path ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path === ".." ||
    path.startsWith("../")
  ) {
    throw new Error(`Unsafe state file path: ${path}`);
  }
}

function assertBranchName(branch: string): void {
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
  ) {
    throw new Error(`Unsafe state branch name: ${branch}`);
  }
}

function isStateSnapshot(value: unknown): value is ClaudeWatchStateSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.schema_version === "number" &&
    typeof value.candidate_id === "string" &&
    typeof value.package_version === "string" &&
    typeof value.npm_integrity === "string" &&
    typeof value.npm_published_at === "string" &&
    typeof value.release_url === "string" &&
    typeof value.release_notes_md === "string" &&
    typeof value.release_published_at === "string" &&
    isDistTags(value.dist_tags) &&
    isRecord(value.docs) &&
    (isRecord(value.runtime) || value.runtime === null) &&
    typeof value.fetched_at === "string" &&
    typeof value.workflow_run_url === "string" &&
    (typeof value.state_commit_parent === "string" ||
      value.state_commit_parent === null) &&
    (value.analysis_parent_sha === undefined ||
      typeof value.analysis_parent_sha === "string" ||
      value.analysis_parent_sha === null)
  );
}

function isDistTags(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.latest === "string" &&
    (typeof value.stable === "string" || value.stable === null) &&
    (typeof value.next === "string" || value.next === null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
