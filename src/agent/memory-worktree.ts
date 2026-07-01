import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;
const HARNESS_GIT_ENV = {
  GIT_AUTHOR_NAME: "Letta Code",
  GIT_AUTHOR_EMAIL: "noreply@letta.com",
  GIT_COMMITTER_NAME: "Letta Code",
  GIT_COMMITTER_EMAIL: "noreply@letta.com",
};

interface GitResult {
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFile("git", args, {
      cwd,
      env: {
        ...process.env,
        ...HARNESS_GIT_ENV,
      },
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5,
    });
    return {
      stdout: stdout?.toString() ?? "",
      stderr: stderr?.toString() ?? "",
    };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const details = [err.message, err.stderr, err.stdout]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n");
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}${details ? `: ${details}` : ""}`,
    );
  }
}

async function tryRunGit(
  cwd: string,
  args: string[],
): Promise<GitResult | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function normalizeGitPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function buildReflectionWorktreeId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export interface ReflectionMemoryWorktree {
  id: string;
  parentMemoryDir: string;
  worktreeBaseDir: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
  gitCommonDir: string;
}

export interface CreateReflectionMemoryWorktreeOptions {
  parentMemoryDir: string;
  now?: Date;
}

export async function createReflectionMemoryWorktree(
  options: CreateReflectionMemoryWorktreeOptions,
): Promise<ReflectionMemoryWorktree> {
  const parentMemoryDir = resolve(options.parentMemoryDir);
  const id = buildReflectionWorktreeId(options.now);
  const worktreeBaseDir = join(dirname(parentMemoryDir), "memory-worktrees");
  const worktreeDir = join(worktreeBaseDir, `reflection-${id}`);
  const branchName = `letta/reflection/${id}`;

  await mkdir(worktreeBaseDir, { recursive: true });

  const { stdout: baseHeadOut } = await runGit(parentMemoryDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const baseHead = baseHeadOut.trim();
  if (!baseHead) {
    throw new Error(
      `Unable to create reflection memory worktree: ${parentMemoryDir} has no HEAD`,
    );
  }

  await runGit(parentMemoryDir, [
    "worktree",
    "add",
    worktreeDir,
    "-b",
    branchName,
    baseHead,
  ]);

  const { stdout: commonDirOut } = await runGit(worktreeDir, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const gitCommonDir = normalizeGitPath(commonDirOut, worktreeDir);

  return {
    id,
    parentMemoryDir,
    worktreeBaseDir,
    worktreeDir,
    branchName,
    baseHead,
    gitCommonDir,
  };
}

export interface ReflectionMemoryScope {
  primaryRoot: string;
  writableRoots: string[];
  readonlyRoots: string[];
}

export function buildReflectionMemoryScope(
  worktree: ReflectionMemoryWorktree,
): ReflectionMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [worktree.worktreeDir, worktree.gitCommonDir],
    readonlyRoots: [dirname(worktree.parentMemoryDir)],
  };
}

export type ReflectionMemoryWorktreeFinalizeStatus =
  | "merged"
  | "no_changes"
  | "pending_conflict"
  | "pending_manual_merge"
  | "dirty_uncommitted"
  | "failed";

export interface ReflectionMemoryWorktreeFinalizeResult {
  status: ReflectionMemoryWorktreeFinalizeStatus;
  parentMemoryDir: string;
  reflectionWorktreeDir: string;
  reflectionBranch: string;
  commitCount: number;
  head?: string;
  summary: string;
  error?: string;
}

export function reflectionIntegrationConsumesTranscript(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return (
    result.status === "merged" ||
    result.status === "no_changes" ||
    result.status === "pending_conflict" ||
    result.status === "pending_manual_merge"
  );
}

export function reflectionIntegrationNeedsReminder(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return (
    result.status === "pending_conflict" ||
    result.status === "pending_manual_merge"
  );
}

export function reflectionIntegrationShouldRecompile(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return result.status === "merged";
}

async function getStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  return stdout.trim();
}

async function getCommitCount(
  worktree: ReflectionMemoryWorktree,
): Promise<number> {
  const { stdout } = await runGit(worktree.worktreeDir, [
    "rev-list",
    "--count",
    `${worktree.baseHead}..HEAD`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

async function getHead(cwd: string): Promise<string | undefined> {
  const result = await tryRunGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const head = result?.stdout.trim();
  return head || undefined;
}

async function cleanupWorktreeAndBranch(
  parentMemoryDir: string,
  worktreeDir: string,
  branchName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  if (existsSync(worktreeDir)) {
    await runGit(parentMemoryDir, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      worktreeDir,
    ]);
  }
  await tryRunGit(parentMemoryDir, [
    "branch",
    options.force ? "-D" : "-d",
    branchName,
  ]);
}

function buildPendingManualResult(
  worktree: ReflectionMemoryWorktree,
  commitCount: number,
  summary: string,
  options: {
    error?: string;
    head?: string;
  } = {},
): ReflectionMemoryWorktreeFinalizeResult {
  return {
    status: "pending_manual_merge",
    parentMemoryDir: worktree.parentMemoryDir,
    reflectionWorktreeDir: worktree.worktreeDir,
    reflectionBranch: worktree.branchName,
    commitCount,
    head: options.head,
    summary,
    error: options.error,
  };
}

export async function finalizeReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
  options: { shouldMerge: boolean },
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  const commitCount = await getCommitCount(worktree);
  const status = await getStatusPorcelain(worktree.worktreeDir);
  const head = await getHead(worktree.worktreeDir);

  if (status.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    return {
      status: "dirty_uncommitted",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection memory worktree had uncommitted changes; it was cleaned up so the transcript can be retried.",
    };
  }

  if (commitCount === 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
    );
    return {
      status: "no_changes",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary: "Reflection made no memory commits.",
    };
  }

  if (!options.shouldMerge) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    return {
      status: "failed",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced committed memory updates, but the subagent did not complete successfully; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  const parentStatus = await getStatusPorcelain(worktree.parentMemoryDir);
  if (parentStatus.length > 0) {
    return buildPendingManualResult(
      worktree,
      commitCount,
      "Reflection produced memory updates, but the parent memory repo has uncommitted changes. Merge was deferred.",
      { head },
    );
  }

  const mergeResult = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    worktree.branchName,
    "--no-edit",
  ]);
  if (!mergeResult) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    return {
      status: "pending_conflict",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced memory updates, but merging them into the parent memory repo has conflicts. The parent merge was aborted and the reflection worktree was preserved for manual merge.",
    };
  }

  const mergedHead = await getHead(worktree.parentMemoryDir);

  await cleanupWorktreeAndBranch(
    worktree.parentMemoryDir,
    worktree.worktreeDir,
    worktree.branchName,
  );

  return {
    status: "merged",
    parentMemoryDir: worktree.parentMemoryDir,
    reflectionWorktreeDir: worktree.worktreeDir,
    reflectionBranch: worktree.branchName,
    commitCount,
    head: mergedHead,
    summary: `Merged ${commitCount} reflection memory commit(s) into parent memory main.`,
  };
}
