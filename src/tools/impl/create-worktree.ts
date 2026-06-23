import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import type { WorktreeProjectConfig } from "@/settings-manager";
import {
  switchConversationWorkingDirectory,
  switchCurrentRuntimeWorkingDirectory,
} from "@/websocket/listener/cwd-change";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { restartWorktreeWatcher } from "@/websocket/listener/worktree-watcher";
import { getShellEnv } from "./shell-env.js";

interface CreateWorktreeArgs {
  name?: string;
  path?: string;
  branch_name?: string;
  base_ref?: string;
  repo_path?: string;
  refresh_base?: boolean;
  switch_cwd?: boolean;
  force?: boolean;
  _executionContextId?: string;
}

interface CreateWorktreeResult {
  content: Array<{ type: "text"; text: string }>;
  status: "success" | "error";
  worktree_path?: string;
  branch_name?: string;
  base_ref?: string;
  switched_cwd?: boolean;
}

type GitResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly result?: GitResult,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const FETCH_GIT_TIMEOUT_MS = 180_000;
const MAX_SLUG_LENGTH = 48;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringArg(
  args: CreateWorktreeArgs,
  key: keyof CreateWorktreeArgs,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[-.]+$/g, "");

  return slug || `worktree-${randomUUID().slice(0, 8)}`;
}

function formatGitFailure(error: unknown): string {
  if (error instanceof GitCommandError) {
    const detail = error.result?.stderr.trim() || error.result?.stdout.trim();
    const formatted = detail ? `${error.message}\n${detail}` : error.message;
    return addWindowsPathLengthHint(formatted);
  }
  return addWindowsPathLengthHint(
    error instanceof Error ? error.message : String(error),
  );
}

export function addWindowsPathLengthHint(
  message: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") {
    return message;
  }

  const normalized = message.toLowerCase();
  const looksLikePathLengthFailure =
    normalized.includes("filename too long") ||
    normalized.includes("could not reset index file to revision");

  if (!looksLikePathLengthFailure) {
    return message;
  }

  return `${message}\n\nThis looks like a Windows path-length issue. Try:\n- git config --global core.longpaths true\n- move the repo to a shorter path, like C:\\src\\<repo>, and retry.`;
}

async function runGit(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: getShellEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        new GitCommandError(
          `Failed to run git ${args.join(" ")}: ${error.message}`,
          args,
        ),
      );
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      const result = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      };

      if (timedOut) {
        reject(
          new GitCommandError(
            `Timed out running git ${args.join(" ")}`,
            args,
            result,
          ),
        );
        return;
      }

      if (exitCode !== 0 && !options.allowFailure) {
        reject(
          new GitCommandError(
            `Failed to run git ${args.join(" ")}`,
            args,
            result,
          ),
        );
        return;
      }

      resolve(result);
    });
  });
}

async function gitStdout(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  return result.stdout.trim();
}

async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], cwd, {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

async function localBranchExists(
  cwd: string,
  branchName: string,
): Promise<boolean> {
  const result = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    cwd,
    { allowFailure: true },
  );
  return result.exitCode === 0;
}

async function assertValidBranchName(
  cwd: string,
  branchName: string,
): Promise<void> {
  const result = await runGit(
    ["check-ref-format", "--branch", branchName],
    cwd,
    {
      allowFailure: true,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Invalid git branch name: ${branchName}`);
  }
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  return await gitStdout(["rev-parse", "--show-toplevel"], cwd);
}

async function resolveWorktreeSourceRoot(params: {
  currentCwd: string;
  requestedRepoPath?: string;
}): Promise<string> {
  const sourcePath = params.requestedRepoPath
    ? path.resolve(params.currentCwd, params.requestedRepoPath)
    : params.currentCwd;

  try {
    return await resolveRepoRoot(sourcePath);
  } catch (error) {
    if (params.requestedRepoPath) {
      throw error;
    }
    throw new Error(
      [
        `Current working directory is not inside a git repository: ${params.currentCwd}`,
        "Pass `repo_path` to CreateWorktree or start the session from inside the target repo.",
        formatGitFailure(error),
      ].join("\n"),
    );
  }
}

async function resolvePrimaryWorktreeRoot(repoRoot: string): Promise<string> {
  const commonDir = await gitStdout(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot,
  );
  return path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : repoRoot;
}

async function resolveDefaultBaseRef(repoRoot: string): Promise<string> {
  const remoteHead = await runGit(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    repoRoot,
    { allowFailure: true },
  );
  const remoteHeadRef = remoteHead.stdout.trim();
  if (remoteHead.exitCode === 0 && remoteHeadRef) {
    return remoteHeadRef;
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await gitRefExists(repoRoot, candidate)) {
      return candidate;
    }
  }

  const currentBranch = await runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
    {
      allowFailure: true,
    },
  );
  const branch = currentBranch.stdout.trim();
  return currentBranch.exitCode === 0 && branch && branch !== "HEAD"
    ? branch
    : "HEAD";
}

async function refreshBaseRef(
  repoRoot: string,
  baseRef: string,
): Promise<void> {
  const slashIndex = baseRef.indexOf("/");
  if (slashIndex <= 0) {
    return;
  }

  const remote = baseRef.slice(0, slashIndex);
  const branch = baseRef.slice(slashIndex + 1);
  const remotes = await runGit(["remote"], repoRoot, { allowFailure: true });
  const hasRemote = remotes.stdout
    .split("\n")
    .map((line) => line.trim())
    .includes(remote);
  if (!hasRemote) {
    return;
  }

  await runGit(
    ["fetch", remote, `${branch}:refs/remotes/${remote}/${branch}`],
    repoRoot,
    {
      timeoutMs: FETCH_GIT_TIMEOUT_MS,
    },
  );
}

async function chooseUniqueWorktreePath(
  worktreesDir: string,
  slug: string,
): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(worktreesDir, `${slug}${suffix}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }

  return path.join(worktreesDir, `${slug}-${randomUUID().slice(0, 8)}`);
}

async function chooseUniqueBranchName(
  repoRoot: string,
  slug: string,
  requestedBranchName?: string,
): Promise<string> {
  if (requestedBranchName) {
    await assertValidBranchName(repoRoot, requestedBranchName);
    if (await localBranchExists(repoRoot, requestedBranchName)) {
      throw new Error(`Branch already exists: ${requestedBranchName}`);
    }
    return requestedBranchName;
  }

  for (let index = 0; index < 10; index += 1) {
    const suffix = randomUUID().slice(0, 8);
    const candidate = `letta/${slug}-${suffix}`;
    await assertValidBranchName(repoRoot, candidate);
    if (!(await localBranchExists(repoRoot, candidate))) {
      return candidate;
    }
  }

  throw new Error("Could not generate a unique worktree branch name");
}

function buildSuccessMessage(params: {
  worktreePath: string;
  branchName: string;
  baseRef: string;
  switchedCwd: boolean;
  provisionNotes: string[];
}): string {
  const provisioning =
    params.provisionNotes.length > 0
      ? [
          "",
          "Provisioning:",
          ...params.provisionNotes.map((note) => `- ${note}`),
        ]
      : ["", "Provisioning: nothing to copy, symlink, or link."];

  const lines = [
    "Created worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchName}`,
    `Base: ${params.baseRef}`,
    ...provisioning,
    "",
    params.switchedCwd
      ? "This conversation's working directory is now the new worktree."
      : "The conversation working directory was left unchanged.",
    "",
    "Next steps:",
    "- Confirm you are in the new worktree with `git status` before editing.",
    "- Read README, AGENTS.md, or other project setup docs before running commands.",
    "- Dependencies (node_modules), git hooks, and ignored files listed in .worktreeinclude are provisioned automatically. Only run a dependency install if the Provisioning section above reported a skip/warning, or if the lockfile differs from the primary checkout.",
    "- Then make changes, test, commit, and push from this worktree.",
  ];
  return lines.join("\n");
}

const DEFAULT_SYMLINK_DIRECTORIES = ["node_modules"];

interface ResolvedProvisionConfig {
  symlinkDirectories: string[];
  copyLocalSettings: boolean;
  linkHooks: boolean;
  include: string[];
}

/**
 * Reads `.letta/settings.json` directly (rather than going through the settings
 * manager's loaded cache, which may not hold the primary root) and resolves the
 * worktree provisioning config, applying defaults for any missing keys.
 */
async function readProvisionConfig(
  primaryRoot: string,
): Promise<ResolvedProvisionConfig> {
  const fallback: ResolvedProvisionConfig = {
    symlinkDirectories: DEFAULT_SYMLINK_DIRECTORIES,
    copyLocalSettings: true,
    linkHooks: true,
    include: [],
  };

  try {
    const raw = await readFile(
      path.join(primaryRoot, ".letta", "settings.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { worktree?: WorktreeProjectConfig };
    const worktree = parsed.worktree;
    if (!worktree) {
      return fallback;
    }
    return {
      symlinkDirectories: Array.isArray(worktree.symlinkDirectories)
        ? worktree.symlinkDirectories.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : DEFAULT_SYMLINK_DIRECTORIES,
      copyLocalSettings: worktree.copyLocalSettings !== false,
      linkHooks: worktree.linkHooks !== false,
      include: Array.isArray(worktree.include)
        ? worktree.include.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
    };
  } catch {
    return fallback;
  }
}

function isUnsafeRelativePath(relPath: string): boolean {
  if (path.isAbsolute(relPath)) {
    return true;
  }
  const normalized = path.normalize(relPath);
  return normalized === ".." || normalized.startsWith(`..${path.sep}`);
}

/**
 * Symlinks `relDir` from the primary checkout into the worktree so large,
 * gitignored directories (node_modules, populated hook dirs) are shared instead
 * of duplicated. Best-effort: skips silently when the source is absent and
 * refuses to clobber a populated destination.
 */
async function symlinkDirIntoWorktree(
  primaryRoot: string,
  worktreePath: string,
  relDir: string,
): Promise<string> {
  if (isUnsafeRelativePath(relDir)) {
    return `⚠ skipped symlink for "${relDir}" (absolute path or escapes the repo)`;
  }
  const normalized = path.normalize(relDir);
  const source = path.join(primaryRoot, normalized);
  const sourceStats = await lstat(source).catch(() => null);
  if (!sourceStats) {
    return ""; // nothing to link (e.g. dependencies not installed in the primary checkout)
  }

  const dest = path.join(worktreePath, normalized);
  const existing = await lstat(dest).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      return "";
    }
    if (existing.isDirectory()) {
      const entries = await readdir(dest);
      if (entries.length > 0) {
        return `⚠ left "${normalized}" as-is (already populated in the worktree)`;
      }
      await rmdir(dest);
    } else {
      return `⚠ left "${normalized}" as-is (unexpected non-directory)`;
    }
  }

  await mkdir(path.dirname(dest), { recursive: true });
  await symlink(source, dest, "dir");
  return `symlinked ${normalized} from the primary checkout`;
}

/**
 * Points the worktree at the primary checkout's git hooks. Worktrees inherit a
 * relative `core.hooksPath` (e.g. husky's `.husky/_`), but that directory's
 * contents are usually gitignored and therefore absent in a fresh worktree, so
 * hooks silently never run. Symlinking the populated hooks dir fixes that
 * without mutating the shared/main git config.
 */
async function linkGitHooks(
  primaryRoot: string,
  worktreePath: string,
): Promise<string> {
  const result = await runGit(
    ["config", "--get", "core.hooksPath"],
    primaryRoot,
    { allowFailure: true },
  );
  const hooksPath = result.stdout.trim();
  if (result.exitCode !== 0 || !hooksPath || path.isAbsolute(hooksPath)) {
    // No custom hooks, or an absolute path that every worktree already shares.
    return "";
  }
  if (isUnsafeRelativePath(hooksPath)) {
    return "";
  }
  const source = path.join(primaryRoot, hooksPath);
  const sourceStats = await lstat(source).catch(() => null);
  if (!sourceStats?.isDirectory()) {
    return "";
  }
  const entries = await readdir(source).catch(() => [] as string[]);
  if (entries.length === 0) {
    return ""; // hooks dir not populated in the primary checkout (e.g. husky not installed)
  }
  const note = await symlinkDirIntoWorktree(
    primaryRoot,
    worktreePath,
    hooksPath,
  );
  return note.startsWith("symlinked")
    ? `wired git hooks (${hooksPath} → primary checkout)`
    : note;
}

async function copyLocalSettingsFile(
  primaryRoot: string,
  worktreePath: string,
): Promise<string> {
  const rel = path.join(".letta", "settings.local.json");
  const source = path.join(primaryRoot, rel);
  const stats = await lstat(source).catch(() => null);
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    return "";
  }
  const dest = path.join(worktreePath, rel);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(source, dest);
  return "copied .letta/settings.local.json";
}

async function readWorktreeIncludeEntries(
  primaryRoot: string,
): Promise<string[]> {
  try {
    const raw = await readFile(
      path.join(primaryRoot, ".worktreeinclude"),
      "utf8",
    );
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    return [];
  }
}

/**
 * Copies a gitignored file or directory (relative to the repo root) from the
 * primary checkout into the worktree. Symlinks are skipped and `.git` is never
 * descended into.
 */
async function copyPathIntoWorktree(
  primaryRoot: string,
  worktreePath: string,
  relPath: string,
): Promise<number> {
  if (isUnsafeRelativePath(relPath)) {
    return 0;
  }
  const normalized = path.normalize(relPath);
  const source = path.join(primaryRoot, normalized);
  const stats = await lstat(source).catch(() => null);
  if (!stats || stats.isSymbolicLink()) {
    return 0;
  }
  if (stats.isFile()) {
    const dest = path.join(worktreePath, normalized);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest);
    return 1;
  }
  if (stats.isDirectory()) {
    let count = 0;
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      count += await copyPathIntoWorktree(
        primaryRoot,
        worktreePath,
        path.join(normalized, entry.name),
      );
    }
    return count;
  }
  return 0;
}

async function copyIncludedFiles(
  primaryRoot: string,
  worktreePath: string,
  extraIncludes: string[],
): Promise<string> {
  const entries = [
    ...(await readWorktreeIncludeEntries(primaryRoot)),
    ...extraIncludes,
  ];
  const unique = [...new Set(entries)];
  let copied = 0;
  for (const entry of unique) {
    copied += await copyPathIntoWorktree(primaryRoot, worktreePath, entry);
  }
  return copied > 0
    ? `copied ${copied} file${copied === 1 ? "" : "s"} via .worktreeinclude`
    : "";
}

/**
 * Provisions a freshly created worktree: symlinks heavy gitignored directories,
 * wires git hooks, copies local settings, and copies `.worktreeinclude` paths.
 * Every step is best-effort — failures are reported as notes and never abort
 * worktree creation.
 */
export async function provisionWorktree(params: {
  primaryRoot: string;
  worktreePath: string;
}): Promise<string[]> {
  const { primaryRoot, worktreePath } = params;
  const config = await readProvisionConfig(primaryRoot);
  const notes: string[] = [];

  const record = async (task: () => Promise<string>): Promise<void> => {
    try {
      const note = await task();
      if (note) {
        notes.push(note);
      }
    } catch (error) {
      notes.push(`⚠ ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  for (const dir of config.symlinkDirectories) {
    await record(() => symlinkDirIntoWorktree(primaryRoot, worktreePath, dir));
  }
  if (config.linkHooks) {
    await record(() => linkGitHooks(primaryRoot, worktreePath));
  }
  if (config.copyLocalSettings) {
    await record(() => copyLocalSettingsFile(primaryRoot, worktreePath));
  }
  await record(() =>
    copyIncludedFiles(primaryRoot, worktreePath, config.include),
  );

  return notes;
}

/**
 * Switches the active session/conversation working directory to `worktreePath`,
 * using the listener-aware path when a runtime is attached and falling back to
 * a plain process chdir otherwise. Shared by the create and enter flows.
 */
async function switchSessionToWorktree(params: {
  worktreePath: string;
  shouldSwitchCwd: boolean;
  runtimeContext: ReturnType<typeof getRuntimeContext>;
  executionContextId?: string;
}): Promise<boolean> {
  if (!params.shouldSwitchCwd) {
    return false;
  }
  const { worktreePath, runtimeContext } = params;

  const listener = getActiveRuntime();
  if (listener && runtimeContext?.conversationId) {
    await switchConversationWorkingDirectory({
      runtime: listener,
      agentId: runtimeContext.agentId ?? null,
      conversationId: runtimeContext.conversationId,
      workingDirectory: worktreePath,
      updateCurrentRuntimeContext: true,
    });
    restartWorktreeWatcher({
      runtime: listener,
      agentId: runtimeContext.agentId ?? null,
      conversationId: runtimeContext.conversationId,
    });
    return true;
  }

  await switchCurrentRuntimeWorkingDirectory(worktreePath);
  if (params.executionContextId) {
    const { updateToolExecutionContextWorkingDirectory } = await import(
      "@/tools/manager"
    );
    updateToolExecutionContextWorkingDirectory(
      params.executionContextId,
      worktreePath,
    );
  }
  return true;
}

/**
 * Cross-agent advisory lock so two conversations do not both switch into the
 * same worktree and clobber each other's uncommitted work. The lock is a small
 * JSON file written into the worktree's per-worktree git admin directory
 * (`<common>/worktrees/<name>/`), which keeps it out of the working tree and
 * lets `git worktree remove` clean it up automatically.
 */
const LOCK_FILENAME = "letta-enter.lock";

export interface WorktreeLockOwner {
  conversationId: string | null;
  agentId: string | null;
}

export interface WorktreeLock {
  conversationId: string | null;
  agentId: string | null;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export type WorktreeLockOutcome =
  | {
      outcome: "acquired" | "reentrant" | "reclaimed" | "forced";
      lock: WorktreeLock;
      previous?: WorktreeLock;
    }
  | { outcome: "conflict"; heldBy: WorktreeLock };

/** Resolves the per-worktree git admin directory, or null if it cannot. */
async function resolveWorktreeGitDir(
  worktreePath: string,
): Promise<string | null> {
  try {
    const gitDir = await gitStdout(
      ["rev-parse", "--absolute-git-dir"],
      worktreePath,
    );
    return gitDir || null;
  } catch {
    return null;
  }
}

function lockOwner(
  runtimeContext: ReturnType<typeof getRuntimeContext>,
): WorktreeLockOwner {
  return {
    conversationId: runtimeContext?.conversationId ?? null,
    agentId: runtimeContext?.agentId ?? null,
  };
}

async function readWorktreeLock(gitDir: string): Promise<WorktreeLock | null> {
  try {
    const raw = await readFile(path.join(gitDir, LOCK_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<WorktreeLock>;
    if (typeof parsed.pid !== "number") {
      return null;
    }
    return {
      conversationId:
        typeof parsed.conversationId === "string"
          ? parsed.conversationId
          : null,
      agentId: typeof parsed.agentId === "string" ? parsed.agentId : null,
      pid: parsed.pid,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      acquiredAt:
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
    };
  } catch {
    return null;
  }
}

async function writeWorktreeLock(
  gitDir: string,
  lock: WorktreeLock,
): Promise<void> {
  await writeFile(
    path.join(gitDir, LOCK_FILENAME),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process. EPERM => the process exists but we may not
    // signal it, which still means it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isHeldByUs(lock: WorktreeLock, owner: WorktreeLockOwner): boolean {
  if (owner.conversationId) {
    return lock.conversationId === owner.conversationId;
  }
  // Anonymous owner (no conversation id): the lock is ours only if this exact
  // process wrote it without a conversation id either.
  return (
    lock.conversationId === null &&
    lock.hostname === os.hostname() &&
    lock.pid === process.pid
  );
}

/**
 * A lock is stale (safe to reclaim) when the process that wrote it is gone. We
 * can only judge liveness on the same host; locks from another machine are
 * treated as live and require `force` to override.
 */
function isStaleLock(lock: WorktreeLock): boolean {
  const sameHost = !lock.hostname || lock.hostname === os.hostname();
  return sameHost && !processIsAlive(lock.pid);
}

function describeHolder(lock: WorktreeLock): string {
  if (lock.conversationId) {
    return `conversation ${lock.conversationId}`;
  }
  return `process ${lock.pid}${lock.hostname ? ` on ${lock.hostname}` : ""}`;
}

function formatLockConflict(lock: WorktreeLock, worktreePath: string): string {
  const since = lock.acquiredAt ? ` since ${lock.acquiredAt}` : "";
  return [
    `Worktree is already in use by another agent (${describeHolder(lock)}${since}).`,
    `Refusing to switch into ${worktreePath} to avoid two agents editing it concurrently.`,
    "If that agent is no longer active, retry with `force: true` to take over the lock.",
  ].join("\n");
}

/**
 * Acquires (or refreshes) the advisory lock for a worktree on behalf of
 * `owner`. Returns a `conflict` outcome when the worktree is actively held by a
 * different, live owner and `force` is not set; otherwise writes the lock and
 * reports how it was obtained.
 */
export async function acquireWorktreeLock(params: {
  worktreeGitDir: string;
  owner: WorktreeLockOwner;
  force?: boolean;
}): Promise<WorktreeLockOutcome> {
  const { worktreeGitDir, owner } = params;
  const force = params.force === true;
  const existing = await readWorktreeLock(worktreeGitDir);

  let outcome: "acquired" | "reentrant" | "reclaimed" | "forced";
  if (!existing) {
    outcome = "acquired";
  } else if (isHeldByUs(existing, owner)) {
    outcome = "reentrant";
  } else if (isStaleLock(existing)) {
    outcome = "reclaimed";
  } else if (force) {
    outcome = "forced";
  } else {
    return { outcome: "conflict", heldBy: existing };
  }

  const lock: WorktreeLock = {
    conversationId: owner.conversationId,
    agentId: owner.agentId,
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };
  await writeWorktreeLock(worktreeGitDir, lock);
  return { outcome, lock, previous: existing ?? undefined };
}

/** Releases `owner`'s lock on a worktree. No-op if it is held by someone else. */
export async function releaseWorktreeLock(params: {
  worktreeGitDir: string;
  owner: WorktreeLockOwner;
}): Promise<boolean> {
  const existing = await readWorktreeLock(params.worktreeGitDir);
  if (!existing || !isHeldByUs(existing, params.owner)) {
    return false;
  }
  await unlink(path.join(params.worktreeGitDir, LOCK_FILENAME)).catch(() => {});
  return true;
}

/**
 * Orchestrates the cross-agent lock for a session that is switching into
 * `worktreePath`: acquires the target lock (throwing on an unforced conflict),
 * then releases this owner's lock on the worktree it is leaving so moving
 * between worktrees does not strand a self-held lock that blocks other agents.
 * Returns a short note for the result message.
 */
async function claimWorktreeLock(params: {
  worktreePath: string;
  previousCwd: string;
  runtimeContext: ReturnType<typeof getRuntimeContext>;
  force: boolean;
}): Promise<string> {
  const owner = lockOwner(params.runtimeContext);
  const targetGitDir = await resolveWorktreeGitDir(params.worktreePath);
  if (!targetGitDir) {
    return "⚠ skipped cross-agent lock (could not resolve the worktree's git dir)";
  }

  const result = await acquireWorktreeLock({
    worktreeGitDir: targetGitDir,
    owner,
    force: params.force,
  });
  if (result.outcome === "conflict") {
    throw new Error(formatLockConflict(result.heldBy, params.worktreePath));
  }

  const previousGitDir = await resolveWorktreeGitDir(params.previousCwd);
  if (previousGitDir && previousGitDir !== targetGitDir) {
    await releaseWorktreeLock({ worktreeGitDir: previousGitDir, owner });
  }

  switch (result.outcome) {
    case "acquired":
      return "locked worktree for this conversation (cross-agent)";
    case "reclaimed":
      return "reclaimed a stale cross-agent lock (previous holder is gone)";
    case "forced":
      return `⚠ force-claimed the worktree lock (was held by ${
        result.previous ? describeHolder(result.previous) : "another agent"
      })`;
    default:
      return ""; // reentrant: this conversation already held it
  }
}

interface RegisteredWorktree {
  worktreePath: string;
  branch?: string;
  isMain: boolean;
  prunable: boolean;
}

/**
 * Parses `git worktree list --porcelain`. The first block is always the main
 * working tree; linked worktrees follow.
 */
async function listRegisteredWorktrees(
  repoRoot: string,
): Promise<RegisteredWorktree[]> {
  const stdout = await gitStdout(["worktree", "list", "--porcelain"], repoRoot);
  const entries: RegisteredWorktree[] = [];
  let current: {
    worktreePath: string;
    branch?: string;
    prunable: boolean;
  } | null = null;

  const flush = (): void => {
    if (current) {
      entries.push({
        worktreePath: current.worktreePath,
        branch: current.branch,
        prunable: current.prunable,
        isMain: entries.length === 0,
      });
      current = null;
    }
  };

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        worktreePath: line.slice("worktree ".length),
        prunable: false,
      };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    } else if (
      current &&
      (line === "prunable" || line.startsWith("prunable "))
    ) {
      current.prunable = true;
    }
  }
  flush();
  return entries;
}

function buildEnteredMessage(params: {
  worktreePath: string;
  branchName?: string;
  switchedCwd: boolean;
  lockNote?: string;
}): string {
  const lines = [
    "Switched to existing worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchName ?? "(detached)"}`,
  ];
  if (params.lockNote) {
    lines.push(`Lock: ${params.lockNote}`);
  }
  lines.push(
    "",
    params.switchedCwd
      ? "This conversation's working directory is now this worktree."
      : "The conversation working directory was left unchanged.",
    "",
    "Next steps:",
    "- Confirm you are in the worktree with `git status` before editing.",
    "- This worktree already existed, so it was not re-provisioned; its dependencies, hooks, and ignored files are whatever it already had.",
  );
  return lines.join("\n");
}

/**
 * Switches the session into an existing worktree. Validation-only: the target
 * must be a registered, non-prunable linked worktree of this repository, living
 * under the managed `.letta/worktrees/` directory. Does not create or
 * re-provision anything.
 */
async function enterExistingWorktree(params: {
  args: CreateWorktreeArgs;
  requestedPath: string;
  runtimeContext: ReturnType<typeof getRuntimeContext>;
}): Promise<CreateWorktreeResult> {
  const { args, requestedPath, runtimeContext } = params;
  const currentCwd =
    runtimeContext?.workingDirectory || process.env.USER_CWD || process.cwd();
  const repoRoot = await resolveWorktreeSourceRoot({
    currentCwd,
    requestedRepoPath: getStringArg(args, "repo_path"),
  });
  const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
  const managedDir = path.join(primaryRoot, ".letta", "worktrees");

  const resolvedTarget = await realpath(
    path.resolve(currentCwd, requestedPath),
  ).catch(() => null);
  if (!resolvedTarget) {
    throw new Error(`Worktree path does not exist: ${requestedPath}`);
  }

  const resolvedManagedDir = await realpath(managedDir).catch(() => null);
  if (
    !resolvedManagedDir ||
    !(
      resolvedTarget === resolvedManagedDir ||
      resolvedTarget.startsWith(resolvedManagedDir + path.sep)
    )
  ) {
    throw new Error(
      `Refusing to enter ${requestedPath}: only worktrees under ${managedDir} (created by CreateWorktree) can be switched into.`,
    );
  }

  const registered = await listRegisteredWorktrees(repoRoot);
  let match: RegisteredWorktree | undefined;
  for (const entry of registered) {
    const entryReal = await realpath(entry.worktreePath).catch(() => null);
    if (entryReal && entryReal === resolvedTarget) {
      match = entry;
      break;
    }
  }
  if (!match) {
    throw new Error(
      `${requestedPath} is not a registered worktree of this repository. Run \`git worktree list\` to see registered worktrees.`,
    );
  }
  if (match.isMain) {
    throw new Error(
      `${requestedPath} is the main working tree, not a linked worktree.`,
    );
  }
  if (match.prunable) {
    throw new Error(
      `${requestedPath} is marked prunable by git (its directory or administrative files are missing or broken).`,
    );
  }

  const shouldSwitchCwd = args.switch_cwd !== false;
  // Acquire the cross-agent lock before switching. A conflict throws and aborts
  // the enter (caught by create_worktree's handler). When we are not switching
  // the session in, we do not take ownership, so we skip the lock.
  const lockNote = shouldSwitchCwd
    ? await claimWorktreeLock({
        worktreePath: resolvedTarget,
        previousCwd: currentCwd,
        runtimeContext,
        force: args.force === true,
      })
    : "";

  const switchedCwd = await switchSessionToWorktree({
    worktreePath: resolvedTarget,
    shouldSwitchCwd,
    runtimeContext,
    executionContextId: getStringArg(args, "_executionContextId"),
  });

  const message = buildEnteredMessage({
    worktreePath: resolvedTarget,
    branchName: match.branch,
    switchedCwd,
    lockNote,
  });

  return {
    content: [{ type: "text", text: message }],
    status: "success",
    worktree_path: resolvedTarget,
    branch_name: match.branch,
    switched_cwd: switchedCwd,
  };
}

export async function create_worktree(
  rawArgs: Record<string, unknown>,
): Promise<CreateWorktreeResult> {
  if (!isObject(rawArgs)) {
    return {
      content: [{ type: "text", text: "Invalid CreateWorktree arguments" }],
      status: "error",
    };
  }

  const args = rawArgs as unknown as CreateWorktreeArgs;
  const requestedPath = getStringArg(args, "path");

  try {
    const runtimeContext = getRuntimeContext();

    // Enter mode: switch into an existing worktree rather than creating one.
    if (requestedPath) {
      if (
        getStringArg(args, "name") ||
        getStringArg(args, "branch_name") ||
        getStringArg(args, "base_ref")
      ) {
        throw new Error(
          "`path` switches into an existing worktree and cannot be combined with `name`, `branch_name`, or `base_ref`.",
        );
      }
      return await enterExistingWorktree({
        args,
        requestedPath,
        runtimeContext,
      });
    }

    // Create mode.
    const name = getStringArg(args, "name");
    if (!name) {
      return {
        content: [
          {
            type: "text",
            text: "Provide `name` to create a new worktree, or `path` to switch into an existing one.",
          },
        ],
        status: "error",
      };
    }

    const currentCwd =
      runtimeContext?.workingDirectory || process.env.USER_CWD || process.cwd();
    const repoRoot = await resolveWorktreeSourceRoot({
      currentCwd,
      requestedRepoPath: getStringArg(args, "repo_path"),
    });
    const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
    const worktreesDir = path.join(primaryRoot, ".letta", "worktrees");
    const slug = slugifyName(name);
    const worktreePath = await chooseUniqueWorktreePath(worktreesDir, slug);
    const branchName = await chooseUniqueBranchName(
      repoRoot,
      slug,
      getStringArg(args, "branch_name"),
    );
    const baseRef =
      getStringArg(args, "base_ref") ?? (await resolveDefaultBaseRef(repoRoot));

    if (args.refresh_base !== false) {
      await refreshBaseRef(repoRoot, baseRef);
    }

    if (!(await gitRefExists(repoRoot, baseRef))) {
      throw new Error(`Base ref does not exist: ${baseRef}`);
    }

    await mkdir(worktreesDir, { recursive: true });
    // `--no-track` keeps the new branch from adopting the base ref (e.g.
    // origin/main) as its upstream, which would otherwise produce misleading
    // ahead/behind status and risk an accidental push to the base branch.
    await runGit(
      [
        "worktree",
        "add",
        "--no-track",
        "-b",
        branchName,
        worktreePath,
        baseRef,
      ],
      repoRoot,
    );

    const normalizedWorktreePath = path.normalize(await realpath(worktreePath));

    let provisionNotes: string[] = [];
    try {
      provisionNotes = await provisionWorktree({
        primaryRoot,
        worktreePath: normalizedWorktreePath,
      });
    } catch (error) {
      provisionNotes = [
        `⚠ provisioning failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }

    const shouldSwitchCwd = args.switch_cwd !== false;
    if (shouldSwitchCwd) {
      try {
        const lockNote = await claimWorktreeLock({
          worktreePath: normalizedWorktreePath,
          previousCwd: currentCwd,
          runtimeContext,
          force: false,
        });
        if (lockNote) {
          provisionNotes.push(lockNote);
        }
      } catch (error) {
        // A brand-new worktree should never conflict, but never let locking
        // abort an otherwise successful creation.
        provisionNotes.push(
          `⚠ cross-agent lock: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const switchedCwd = await switchSessionToWorktree({
      worktreePath: normalizedWorktreePath,
      shouldSwitchCwd,
      runtimeContext,
      executionContextId: getStringArg(args, "_executionContextId"),
    });

    const message = buildSuccessMessage({
      worktreePath: normalizedWorktreePath,
      branchName,
      baseRef,
      switchedCwd,
      provisionNotes,
    });

    return {
      content: [{ type: "text", text: message }],
      status: "success",
      worktree_path: normalizedWorktreePath,
      branch_name: branchName,
      base_ref: baseRef,
      switched_cwd: switchedCwd,
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${formatGitFailure(error)}` }],
      status: "error",
    };
  }
}
