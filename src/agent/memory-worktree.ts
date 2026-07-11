import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "@/agent/memory-git-signing";
import { debugLog } from "@/utils/debug";

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
    const allArgs = [...GIT_DISABLE_COMMIT_SIGNING_ARGS, ...args];
    const { stdout, stderr } = await execFile("git", allArgs, {
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

function summarizeReflectionCommitSubject(subject: string): string {
  const summary = subject
    .trim()
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
  return summary || "reflection memory updates";
}

async function buildReflectionMergeMessage(
  parentMemoryDir: string,
  branchName: string,
): Promise<string> {
  const result = await tryRunGit(parentMemoryDir, [
    "log",
    "-1",
    "--pretty=%s",
    branchName,
  ]);
  const summary = summarizeReflectionCommitSubject(result?.stdout ?? "");
  return `merge(reflection): ${summary}`;
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
  debugLog(
    "memfs-git",
    "reflection worktree created id=%s branch=%s dir=%s parent=%s baseHead=%s gitCommonDir=%s",
    id,
    branchName,
    worktreeDir,
    parentMemoryDir,
    baseHead,
    gitCommonDir,
  );

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

export interface PendingReflectionMemoryWorktree {
  id: string;
  parentMemoryDir: string;
  reflectionWorktreeDir: string;
  reflectionBranch: string;
  commitCount: number;
  head?: string;
}

function buildPendingResultFromPending(
  pending: PendingReflectionMemoryWorktree,
  status: "pending_conflict" | "pending_manual_merge",
  summary: string,
  error?: string,
): ReflectionMemoryWorktreeFinalizeResult {
  return {
    status,
    parentMemoryDir: pending.parentMemoryDir,
    reflectionWorktreeDir: pending.reflectionWorktreeDir,
    reflectionBranch: pending.reflectionBranch,
    commitCount: pending.commitCount,
    head: pending.head,
    summary,
    error,
  };
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

async function getBranchCommitCount(
  parentMemoryDir: string,
  branchName: string,
): Promise<number> {
  const result = await tryRunGit(parentMemoryDir, [
    "rev-list",
    "--count",
    `HEAD..${branchName}`,
  ]);
  return Number.parseInt(result?.stdout.trim() ?? "", 10) || 0;
}

function parseWorktreeListPorcelain(
  output: string,
): Array<{ path: string; head?: string; branch?: string }> {
  const entries: Array<{ path: string; head?: string; branch?: string }> = [];
  for (const block of output.split(/\n\s*\n/)) {
    const entry: { path?: string; head?: string; branch?: string } = {};
    for (const line of block.split("\n")) {
      const separatorIndex = line.indexOf(" ");
      const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
      if (key === "worktree") entry.path = value;
      if (key === "HEAD") entry.head = value;
      if (key === "branch") entry.branch = value;
    }
    if (!entry.path) continue;
    entries.push({
      path: entry.path,
      ...(entry.head ? { head: entry.head } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
    });
  }
  return entries;
}

export async function listPendingReflectionMemoryWorktrees(
  parentMemoryDir: string,
): Promise<PendingReflectionMemoryWorktree[]> {
  const resolvedParent = await realpath(resolve(parentMemoryDir));
  const worktreeBaseDir = join(dirname(resolvedParent), "memory-worktrees");
  const worktreeList = await tryRunGit(resolvedParent, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (!worktreeList) return [];

  const pending: PendingReflectionMemoryWorktree[] = [];
  for (const entry of parseWorktreeListPorcelain(worktreeList.stdout)) {
    const worktreeDir = normalizeGitPath(entry.path, resolvedParent);
    const relativeWorktreeDir = relative(worktreeBaseDir, worktreeDir);
    if (relativeWorktreeDir.startsWith("..") || isAbsolute(relativeWorktreeDir))
      continue;

    const branchName = entry.branch?.startsWith("refs/heads/")
      ? entry.branch.slice("refs/heads/".length)
      : undefined;
    if (!branchName?.startsWith("letta/reflection/")) continue;

    const isMerged = await tryRunGit(resolvedParent, [
      "merge-base",
      "--is-ancestor",
      branchName,
      "HEAD",
    ]);
    if (isMerged) {
      await cleanupWorktreeAndBranch(resolvedParent, worktreeDir, branchName, {
        force: true,
      });
      debugLog(
        "memfs-git",
        "reflection pending scan cleaned already-merged branch=%s worktree=%s",
        branchName,
        worktreeDir,
      );
      continue;
    }

    pending.push({
      id: branchName.slice("letta/reflection/".length),
      parentMemoryDir: resolvedParent,
      reflectionWorktreeDir: worktreeDir,
      reflectionBranch: branchName,
      commitCount: await getBranchCommitCount(resolvedParent, branchName),
      head: entry.head,
    });
  }

  if (pending.length > 0) {
    debugLog(
      "memfs-git",
      "reflection pending scan found=%d parent=%s branches=%s",
      pending.length,
      resolvedParent,
      pending.map((entry) => entry.reflectionBranch).join(","),
    );
  }

  return pending;
}

export async function integratePendingReflectionMemoryWorktrees(
  parentMemoryDir: string,
): Promise<ReflectionMemoryWorktreeFinalizeResult[]> {
  const pendingWorktrees =
    await listPendingReflectionMemoryWorktrees(parentMemoryDir);
  const unresolved: ReflectionMemoryWorktreeFinalizeResult[] = [];

  for (const pending of pendingWorktrees) {
    const isMerged = await tryRunGit(pending.parentMemoryDir, [
      "merge-base",
      "--is-ancestor",
      pending.reflectionBranch,
      "HEAD",
    ]);
    if (isMerged) {
      await cleanupWorktreeAndBranch(
        pending.parentMemoryDir,
        pending.reflectionWorktreeDir,
        pending.reflectionBranch,
        { force: true },
      );
      debugLog(
        "memfs-git",
        "reflection pending integration cleaned already-merged branch=%s worktree=%s",
        pending.reflectionBranch,
        pending.reflectionWorktreeDir,
      );
      continue;
    }

    const worktreeStatus = await getStatusPorcelain(
      pending.reflectionWorktreeDir,
    );
    if (worktreeStatus.length > 0) {
      unresolved.push(
        buildPendingResultFromPending(
          pending,
          "pending_manual_merge",
          "A previously unresolved reflection memory worktree has uncommitted changes. Background merge was deferred.",
        ),
      );
      debugLog(
        "memfs-git",
        "reflection pending integration deferred branch=%s reason=worktree_dirty worktree=%s",
        pending.reflectionBranch,
        pending.reflectionWorktreeDir,
      );
      continue;
    }

    const parentStatus = await getStatusPorcelain(pending.parentMemoryDir);
    if (parentStatus.length > 0) {
      unresolved.push(
        buildPendingResultFromPending(
          pending,
          "pending_manual_merge",
          "A previously unresolved reflection memory worktree is still unmerged, and the parent memory repo has uncommitted changes. Background merge was deferred.",
        ),
      );
      debugLog(
        "memfs-git",
        "reflection pending integration deferred branch=%s reason=parent_dirty",
        pending.reflectionBranch,
      );
      continue;
    }

    const mergeMessage = await buildReflectionMergeMessage(
      pending.parentMemoryDir,
      pending.reflectionBranch,
    );
    const mergeResult = await tryRunGit(pending.parentMemoryDir, [
      "merge",
      pending.reflectionBranch,
      "-m",
      mergeMessage,
    ]);
    if (!mergeResult) {
      await tryRunGit(pending.parentMemoryDir, ["merge", "--abort"]);
      unresolved.push(
        buildPendingResultFromPending(
          pending,
          "pending_conflict",
          "A previously unresolved reflection memory worktree still has conflicts. The parent merge was aborted and the reflection worktree was preserved.",
        ),
      );
      debugLog(
        "memfs-git",
        "reflection pending integration conflicted branch=%s mergeAbort=true preservedWorktree=%s",
        pending.reflectionBranch,
        pending.reflectionWorktreeDir,
      );
      continue;
    }

    const mergedHead = await getHead(pending.parentMemoryDir);
    await cleanupWorktreeAndBranch(
      pending.parentMemoryDir,
      pending.reflectionWorktreeDir,
      pending.reflectionBranch,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection pending integration merged branch=%s commitCount=%d parentHead=%s cleanedUp=true",
      pending.reflectionBranch,
      pending.commitCount,
      mergedHead ?? "<none>",
    );
  }

  return unresolved;
}

async function cleanupWorktreeAndBranch(
  parentMemoryDir: string,
  worktreeDir: string,
  branchName: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const removedWorktree = existsSync(worktreeDir);
  if (removedWorktree) {
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
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=dirty_uncommitted commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
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
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=no_changes cleanedUp=true",
      worktree.id,
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
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=failed commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
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
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=pending_manual_merge reason=parent_dirty branch=%s preservedWorktree=%s",
      worktree.id,
      worktree.branchName,
      worktree.worktreeDir,
    );
    return buildPendingManualResult(
      worktree,
      commitCount,
      "Reflection produced memory updates, but the parent memory repo has uncommitted changes. Merge was deferred.",
      { head },
    );
  }

  debugLog(
    "memfs-git",
    "reflection merge attempt id=%s branch=%s parent=%s commitCount=%d",
    worktree.id,
    worktree.branchName,
    worktree.parentMemoryDir,
    commitCount,
  );
  const mergeMessage = await buildReflectionMergeMessage(
    worktree.parentMemoryDir,
    worktree.branchName,
  );
  const mergeResult = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    worktree.branchName,
    "-m",
    mergeMessage,
  ]);
  if (!mergeResult) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=pending_conflict branch=%s mergeAbort=true preservedWorktree=%s",
      worktree.id,
      worktree.branchName,
      worktree.worktreeDir,
    );
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
  debugLog(
    "memfs-git",
    "reflection finalized id=%s status=merged commitCount=%d parentHead=%s cleanedUp=true",
    worktree.id,
    commitCount,
    mergedHead ?? "<none>",
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
