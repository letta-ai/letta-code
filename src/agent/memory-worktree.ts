import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

export function buildReflectionIntegrationMemoryScope(
  worktree: ReflectionMemoryWorktree,
): ReflectionMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [
      worktree.worktreeDir,
      worktree.parentMemoryDir,
      worktree.gitCommonDir,
    ],
    readonlyRoots: [],
  };
}

export type ReflectionMemoryWorktreeFinalizeStatus =
  | "merged"
  | "no_changes"
  | "parent_dirty"
  | "merge_conflict"
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
  failurePhase?: "reflection" | "integration";
}

export function reflectionIntegrationConsumesTranscript(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return result.status === "merged" || result.status === "no_changes";
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

export async function reflectionMemoryParentHasChanges(
  parentMemoryDir: string,
): Promise<boolean> {
  return (await getStatusPorcelain(resolve(parentMemoryDir))).length > 0;
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

export interface ReflectionMemoryWorktreeState {
  commitCount: number;
  dirty: boolean;
  head?: string;
}

export async function inspectReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
): Promise<ReflectionMemoryWorktreeState> {
  return {
    commitCount: await getCommitCount(worktree),
    dirty: (await getStatusPorcelain(worktree.worktreeDir)).length > 0,
    head: await getHead(worktree.worktreeDir),
  };
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

async function finalizeReflectionMemoryWorktreeImpl(
  worktree: ReflectionMemoryWorktree,
  options: ReflectionMemoryWorktreeFinalizeOptions,
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  if (!existsSync(worktree.worktreeDir) && options.knownNoChanges) {
    const branchHead = (
      await tryRunGit(worktree.parentMemoryDir, [
        "rev-parse",
        "--verify",
        worktree.branchName,
      ])
    )?.stdout.trim();
    if (branchHead && branchHead !== worktree.baseHead) {
      throw new Error(
        `Cannot finalize missing reflection worktree ${worktree.worktreeDir} as no-op: ${worktree.branchName} advanced from ${worktree.baseHead} to ${branchHead}`,
      );
    }
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=no_changes worktreeMissing=true cleanedUp=true",
      worktree.id,
    );
    return {
      status: "no_changes",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount: 0,
      head: worktree.baseHead,
      summary: "Reflection made no memory commits.",
    };
  }

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
        "Reflection subagent did not complete successfully; the worktree was cleaned up so the transcript can be retried.",
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

  const parentStatus = await getStatusPorcelain(worktree.parentMemoryDir);
  if (parentStatus.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=parent_dirty commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "parent_dirty",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced memory updates, but the parent memory repo had uncommitted changes; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  if (options.requireAlreadyMerged) {
    const alreadyMerged = await tryRunGit(worktree.parentMemoryDir, [
      "merge-base",
      "--is-ancestor",
      worktree.branchName,
      "HEAD",
    ]);
    if (!alreadyMerged) {
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
        failurePhase: "integration",
        summary:
          options.failureSummary ??
          "The primary-agent integration conversation did not merge the reflection branch; the worktree was cleaned up so the transcript can be retried.",
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
      "reflection finalized id=%s status=merged integration=primary_agent commitCount=%d parentHead=%s cleanedUp=true",
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
      summary: `Primary agent integrated ${commitCount} reflection memory commit(s).`,
    };
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
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=merge_conflict commitCount=%d mergeAbort=true cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "merge_conflict",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced memory updates, but merging them into the parent memory repo conflicted; the worktree was cleaned up so the transcript can be retried.",
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

export async function finalizeReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
  options: ReflectionMemoryWorktreeFinalizeOptions,
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  return await finalizeReflectionMemoryWorktreeImpl(worktree, options);
}

export interface ReflectionMemoryWorktreeFinalizeOptions {
  shouldMerge: boolean;
  knownNoChanges?: boolean;
  failureSummary?: string;
  requireAlreadyMerged?: boolean;
}
