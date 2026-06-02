import { execFile as execFileCb } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export type WorktreeDiffOption = {
  path: string;
  name: string;
  branch: string;
  head: string;
  isCurrent: boolean;
  fileCount: number;
  insertions: number;
  deletions: number;
  hasChanges: boolean;
};

type GitExecError = Error & {
  stderr?: string | Buffer;
};

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout?.toString() ?? "";
  } catch (error) {
    const gitError = error as GitExecError;
    const stderr = gitError.stderr?.toString().trim();
    throw new Error(stderr || gitError.message);
  }
}

async function runGitOptional(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGit(cwd, args);
  } catch {
    return "";
  }
}

function parseNumstat(numstat: string): {
  insertions: number;
  deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [added, removed] = line.split("\t");
    const addedCount = Number(added);
    const removedCount = Number(removed);
    if (Number.isFinite(addedCount)) insertions += addedCount;
    if (Number.isFinite(removedCount)) deletions += removedCount;
  }
  return { insertions, deletions };
}

function parseWorktreeList(
  output: string,
  currentPath: string,
): WorktreeDiffOption[] {
  const worktrees: WorktreeDiffOption[] = [];
  let current: Partial<WorktreeDiffOption> | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current?.path) {
        worktrees.push({
          path: current.path,
          name: basename(current.path),
          branch: current.branch ?? "detached",
          head: current.head ?? "",
          isCurrent: current.path === currentPath,
          fileCount: 0,
          insertions: 0,
          deletions: 0,
          hasChanges: false,
        });
      }
      current = null;
      continue;
    }

    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      current = { path: value };
    } else if (current && key === "HEAD") {
      current.head = value;
    } else if (current && key === "branch") {
      current.branch = value.replace(/^refs\/heads\//, "");
    }
  }

  if (current?.path) {
    worktrees.push({
      path: current.path,
      name: basename(current.path),
      branch: current.branch ?? "detached",
      head: current.head ?? "",
      isCurrent: current.path === currentPath,
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      hasChanges: false,
    });
  }

  return worktrees;
}

async function getDiffBase(cwd: string): Promise<string> {
  const upstream = (
    await runGitOptional(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ])
  ).trim();
  const defaultBranch = (
    await runGitOptional(cwd, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ])
  ).trim();
  const baseRef = upstream || defaultBranch || "HEAD";
  const mergeBase = (
    await runGitOptional(cwd, ["merge-base", baseRef, "HEAD"])
  ).trim();
  return mergeBase || baseRef;
}

async function summarizeWorktree(
  worktree: WorktreeDiffOption,
): Promise<WorktreeDiffOption> {
  const diffBase = await getDiffBase(worktree.path);
  const [names, numstat, untracked] = await Promise.all([
    runGitOptional(worktree.path, ["diff", "--name-only", diffBase]),
    runGitOptional(worktree.path, ["diff", "--numstat", diffBase]),
    runGitOptional(worktree.path, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  ]);
  const changedPaths = new Set(
    [...names.split("\n"), ...untracked.split("\n")]
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const stats = parseNumstat(numstat);

  return {
    ...worktree,
    fileCount: changedPaths.size,
    insertions: stats.insertions,
    deletions: stats.deletions,
    hasChanges: changedPaths.size > 0,
  };
}

export async function listWorktreeDiffOptions(
  cwd: string = process.cwd(),
): Promise<WorktreeDiffOption[]> {
  const currentPath = (
    await runGit(cwd, ["rev-parse", "--show-toplevel"])
  ).trim();
  const output = await runGit(currentPath, ["worktree", "list", "--porcelain"]);
  const worktrees = parseWorktreeList(output, currentPath);
  return Promise.all(worktrees.map((worktree) => summarizeWorktree(worktree)));
}
