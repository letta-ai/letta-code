import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { getAuthToken } from "@/agent/memory-auth";
import {
  type MemoryCommitAuthor,
  runGit as runMemoryGit,
} from "@/agent/memory-git";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "@/agent/memory-git-signing";
import { getMemfsServerUrl } from "@/backend/api/memfs-git-proxy";
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

async function runGit(
  cwd: string,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  try {
    const allArgs = [...GIT_DISABLE_COMMIT_SIGNING_ARGS, ...args];
    const { stdout, stderr } = await execFile("git", allArgs, {
      cwd,
      env: {
        ...process.env,
        ...HARNESS_GIT_ENV,
        ...extraEnv,
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

function buildWriterWorktreeId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export interface MemoryWriterWorktree {
  id: string;
  parentMemoryDir: string;
  worktreeBaseDir: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
  gitCommonDir: string;
}

export interface MemoryWriterMemoryScope {
  primaryRoot: string;
  writableRoots: string[];
  readonlyRoots: string[];
}

export type MemoryWriterFinalizeStatus =
  | "applied"
  | "noop"
  | "needs_review"
  | "failed";

export interface MemoryWriterFinalizeResult {
  status: MemoryWriterFinalizeStatus;
  parentMemoryDir: string;
  worktreeDir: string;
  branchName: string;
  commitCount: number;
  head?: string;
  summary: string;
  affectedPaths: string[];
  error?: string;
  patch?: string;
}

export async function createMemoryWriterWorktree(options: {
  parentMemoryDir: string;
  now?: Date;
}): Promise<MemoryWriterWorktree> {
  const parentMemoryDir = resolve(options.parentMemoryDir);
  const id = buildWriterWorktreeId(options.now);
  const worktreeBaseDir = join(dirname(parentMemoryDir), "memory-worktrees");
  const worktreeDir = join(worktreeBaseDir, `memory-writer-${id}`);
  const branchName = `letta/memory-writer/${id}`;

  await mkdir(worktreeBaseDir, { recursive: true });

  const { stdout: baseHeadOut } = await runGit(parentMemoryDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const baseHead = baseHeadOut.trim();
  if (!baseHead) {
    throw new Error(
      `Unable to create memory-writer worktree: ${parentMemoryDir} has no HEAD`,
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
    "memory-writer worktree created id=%s branch=%s dir=%s parent=%s baseHead=%s",
    id,
    branchName,
    worktreeDir,
    parentMemoryDir,
    baseHead,
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

export function buildMemoryWriterScope(
  worktree: MemoryWriterWorktree,
): MemoryWriterMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [worktree.worktreeDir, worktree.gitCommonDir],
    readonlyRoots: [dirname(worktree.parentMemoryDir)],
  };
}

async function getStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  return stdout.trim();
}

async function getCommitCount(worktree: MemoryWriterWorktree): Promise<number> {
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

async function listChangedPaths(
  worktree: MemoryWriterWorktree,
): Promise<string[]> {
  const result = await tryRunGit(worktree.worktreeDir, [
    "diff",
    "--name-only",
    worktree.baseHead,
  ]);
  const committed = (result?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty = (await getStatusPorcelain(worktree.worktreeDir))
    .split("\n")
    .map((line) => line.trim().slice(3).trim())
    .filter(Boolean);
  return Array.from(new Set([...committed, ...dirty]));
}

async function collectDurablePatch(
  worktree: MemoryWriterWorktree,
): Promise<string> {
  const committed =
    (await tryRunGit(worktree.worktreeDir, ["diff", worktree.baseHead, "HEAD"]))
      ?.stdout ?? "";
  const uncommitted =
    (await tryRunGit(worktree.worktreeDir, ["diff"]))?.stdout ?? "";
  return [committed.trim(), uncommitted.trim()].filter(Boolean).join("\n\n");
}

async function refreshParentFromOrigin(parentMemoryDir: string): Promise<void> {
  const origin = await tryRunGit(parentMemoryDir, [
    "config",
    "--get",
    "remote.origin.url",
  ]);
  if (!origin) {
    return;
  }

  const memfsPrefix = `${getMemfsServerUrl().trim().replace(/\/+$/, "")}/v1/git/`;
  const token = origin.stdout.trim().startsWith(memfsPrefix)
    ? await getAuthToken()
    : undefined;
  await runMemoryGit(parentMemoryDir, ["fetch", "origin", "main"], token, {
    timeoutMs: GIT_TIMEOUT_MS,
  });

  const remoteIsAncestor = await tryRunGit(parentMemoryDir, [
    "merge-base",
    "--is-ancestor",
    "origin/main",
    "HEAD",
  ]);
  if (remoteIsAncestor) {
    return;
  }

  const localIsAncestor = await tryRunGit(parentMemoryDir, [
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "origin/main",
  ]);
  if (localIsAncestor) {
    await runGit(parentMemoryDir, ["merge", "--ff-only", "origin/main"]);
    return;
  }

  try {
    await runGit(parentMemoryDir, ["rebase", "origin/main"]);
  } catch (error) {
    await tryRunGit(parentMemoryDir, ["rebase", "--abort"]);
    throw error;
  }
}

async function cleanupWorktreeAndBranch(
  worktree: MemoryWriterWorktree,
  options: { force?: boolean } = {},
): Promise<void> {
  if (existsSync(worktree.worktreeDir)) {
    await runGit(worktree.parentMemoryDir, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      worktree.worktreeDir,
    ]);
  }
  await tryRunGit(worktree.parentMemoryDir, [
    "branch",
    options.force ? "-D" : "-d",
    worktree.branchName,
  ]);
}

function buildCommitMessage(params: {
  reason: string;
  jobId: string;
  writerAgentId?: string;
  parentAgentId: string;
}): string {
  const subject = params.reason.trim() || "Update memory";
  return [
    subject,
    "",
    "Generated-By: Letta Code",
    `Memory-Job-ID: ${params.jobId}`,
    params.writerAgentId ? `Writer-Agent-ID: ${params.writerAgentId}` : null,
    `Parent-Agent-ID: ${params.parentAgentId}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export async function commitMemoryWriterProposal(options: {
  worktree: MemoryWriterWorktree;
  author: MemoryCommitAuthor;
  jobId: string;
  writerAgentId?: string;
  reason: string;
}): Promise<{ committed: boolean; sha?: string; affectedPaths: string[] }> {
  const affectedPaths = await listChangedPaths(options.worktree);
  const dirty = await getStatusPorcelain(options.worktree.worktreeDir);
  if (!dirty) {
    const commitCount = await getCommitCount(options.worktree);
    return {
      committed: commitCount > 0,
      sha: await getHead(options.worktree.worktreeDir),
      affectedPaths,
    };
  }

  const authorName = options.author.authorName.trim() || options.author.agentId;
  await runGit(options.worktree.worktreeDir, ["add", "-A", "--", "."]);
  await runGit(
    options.worktree.worktreeDir,
    [
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${options.author.authorEmail}`,
      "commit",
      "-m",
      buildCommitMessage({
        reason: options.reason,
        jobId: options.jobId,
        writerAgentId: options.writerAgentId,
        parentAgentId: options.author.agentId,
      }),
    ],
    {
      GIT_AUTHOR_NAME: authorName,
      GIT_AUTHOR_EMAIL: options.author.authorEmail,
      GIT_COMMITTER_NAME: authorName,
      GIT_COMMITTER_EMAIL: options.author.authorEmail,
    },
  );

  return {
    committed: true,
    sha: await getHead(options.worktree.worktreeDir),
    affectedPaths,
  };
}

export async function integrateMemoryWriterWorktree(options: {
  worktree: MemoryWriterWorktree;
  shouldIntegrate: boolean;
  preserveOnFailure?: boolean;
}): Promise<MemoryWriterFinalizeResult> {
  const { worktree } = options;
  const preserve = options.preserveOnFailure ?? true;
  const commitCount = existsSync(worktree.worktreeDir)
    ? await getCommitCount(worktree)
    : 0;
  const head = existsSync(worktree.worktreeDir)
    ? await getHead(worktree.worktreeDir)
    : undefined;
  const affectedPaths = existsSync(worktree.worktreeDir)
    ? await listChangedPaths(worktree)
    : [];

  const baseResult = {
    parentMemoryDir: worktree.parentMemoryDir,
    worktreeDir: worktree.worktreeDir,
    branchName: worktree.branchName,
    commitCount,
    head,
    affectedPaths,
  };

  if (!options.shouldIntegrate) {
    if (!preserve) {
      await cleanupWorktreeAndBranch(worktree, { force: true });
    }
    return {
      ...baseResult,
      status: "failed",
      summary:
        "Memory writer did not complete successfully; the proposal was not integrated.",
    };
  }

  if (existsSync(worktree.worktreeDir)) {
    const dirty = await getStatusPorcelain(worktree.worktreeDir);
    if (dirty) {
      const patch = await collectDurablePatch(worktree);
      return {
        ...baseResult,
        status: "needs_review",
        patch,
        summary:
          "Memory writer left uncommitted changes; the proposal branch was preserved for review.",
      };
    }
  }

  if (commitCount === 0) {
    await cleanupWorktreeAndBranch(worktree, { force: true });
    return {
      ...baseResult,
      status: "noop",
      summary: "No memory change was needed; this was already captured.",
    };
  }

  const parentStatus = await getStatusPorcelain(worktree.parentMemoryDir);
  if (parentStatus.length > 0) {
    const patch = await collectDurablePatch(worktree);
    return {
      ...baseResult,
      status: "needs_review",
      patch,
      summary:
        "Memory writer produced updates, but the parent memory repo has uncommitted changes. The proposal branch was preserved.",
    };
  }

  try {
    await refreshParentFromOrigin(worktree.parentMemoryDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const patch = await collectDurablePatch(worktree);
    return {
      ...baseResult,
      status: "needs_review",
      patch,
      error: message,
      summary:
        "Memory writer produced updates, but the parent memory repo could not be refreshed. The proposal branch was preserved.",
    };
  }

  const parentHead = await getHead(worktree.parentMemoryDir);
  if (parentHead && parentHead !== worktree.baseHead) {
    const rebase = await tryRunGit(worktree.worktreeDir, [
      "rebase",
      parentHead,
    ]);
    if (!rebase) {
      await tryRunGit(worktree.worktreeDir, ["rebase", "--abort"]);
      await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
      const patch = await collectDurablePatch(worktree);
      return {
        ...baseResult,
        status: "needs_review",
        patch,
        summary:
          "Memory update needs review: rebasing the proposal onto the latest parent HEAD conflicted. Main was left clean.",
      };
    }
  }

  const mergeResult = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    "--ff-only",
    worktree.branchName,
  ]);
  if (!mergeResult) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    const patch = await collectDurablePatch(worktree);
    return {
      ...baseResult,
      status: "needs_review",
      patch,
      summary:
        "Memory update needs review: fast-forwarding the proposal into parent memory conflicted. Main was left clean.",
    };
  }

  const mergedHead = await getHead(worktree.parentMemoryDir);
  await cleanupWorktreeAndBranch(worktree);
  debugLog(
    "memfs-git",
    "memory-writer finalized id=%s status=applied commitCount=%d parentHead=%s",
    worktree.id,
    commitCount,
    mergedHead ?? "<none>",
  );

  return {
    ...baseResult,
    status: "applied",
    head: mergedHead,
    affectedPaths,
    summary:
      affectedPaths.length > 0
        ? `Memory updated: ${affectedPaths.join(", ")}`
        : `Merged ${commitCount} memory-writer commit(s) into parent memory main.`,
  };
}

export async function writeDurablePatchFile(
  patchPath: string,
  patch: string,
): Promise<void> {
  await mkdir(dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patch.endsWith("\n") ? patch : `${patch}\n`, {
    encoding: "utf8",
  });
}

export async function discardMemoryWriterWorktree(
  worktree: MemoryWriterWorktree,
): Promise<void> {
  await cleanupWorktreeAndBranch(worktree, { force: true });
}
