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
} from "node:fs/promises";
import path from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import type { WorktreeProjectConfig } from "@/settings-manager";
import {
  acquireWorktreeLock,
  describeHolder,
  releaseWorktreeLock,
  type WorktreeLock,
  type WorktreeLockOwner,
} from "@/utils/worktree-lock";
import {
  switchConversationWorkingDirectory,
  switchCurrentRuntimeWorkingDirectory,
  updateToolExecutionContextCwd,
} from "@/websocket/listener/cwd-change";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { restartWorktreeWatcher } from "@/websocket/listener/worktree-watcher";
import { getShellEnv } from "./shell-env.js";

interface EnterWorktreeArgs {
  name?: string;
  path?: string;
  branch_name?: string;
  base_ref?: string;
  repo_path?: string;
  refresh_base?: boolean;
  switch_cwd?: boolean;
  symlink_dependencies?: boolean;
  force?: boolean;
  _executionContextId?: string;
}

interface EnterWorktreeResult {
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
  args: EnterWorktreeArgs,
  key: keyof EnterWorktreeArgs,
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
        "Pass `repo_path` to EnterWorktree or start the session from inside the target repo.",
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

/**
 * Resolves the common prelude shared by the create and enter flows: the current
 * cwd, the repo root for `repo_path`/cwd, the primary checkout root, and the
 * managed `.letta/worktrees/` directory under it.
 */
async function resolveWorktreeContext(params: {
  args: EnterWorktreeArgs;
  runtimeContext: ReturnType<typeof getRuntimeContext>;
}): Promise<{
  currentCwd: string;
  repoRoot: string;
  primaryRoot: string;
  managedDir: string;
}> {
  const currentCwd =
    params.runtimeContext?.workingDirectory ||
    process.env.USER_CWD ||
    process.cwd();
  const repoRoot = await resolveWorktreeSourceRoot({
    currentCwd,
    requestedRepoPath: getStringArg(params.args, "repo_path"),
  });
  const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
  const managedDir = path.join(primaryRoot, ".letta", "worktrees");
  return { currentCwd, repoRoot, primaryRoot, managedDir };
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
  linkedDependencies: boolean;
}): string {
  const provisioning =
    params.provisionNotes.length > 0
      ? [
          "",
          "Provisioning:",
          ...params.provisionNotes.map((note) => `- ${note}`),
        ]
      : ["", "Provisioning: nothing to copy, symlink, or link."];

  // The dependency directories are SYMLINKED to the primary checkout, so a
  // package install in this worktree writes through to the primary checkout's
  // node_modules. Tell the agent how to opt out when it needs its own deps.
  const dependencyStep = params.linkedDependencies
    ? "- Dependencies (e.g. node_modules) are symlinked from the primary checkout and ready to use. Do NOT run a package install here — it would modify the primary checkout's dependencies. If this worktree needs different or isolated packages, recreate it with `symlink_dependencies: false` and install fresh."
    : "- Dependencies were not symlinked. If the project has dependencies, install them with the repo's package manager (check whether it uses bun, pnpm, yarn, or npm) before building or testing.";

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
    dependencyStep,
    "- Git hooks and ignored files listed in .worktreeinclude are provisioned automatically.",
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

/** True when `child` is `parent` or nested under it (path-based, no realpath). */
function isPathWithin(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent + path.sep)
  );
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
): Promise<{ linked: boolean; note: string }> {
  const skip = (note: string) => ({ linked: false, note });
  if (isUnsafeRelativePath(relDir)) {
    return skip(
      `⚠ skipped symlink for "${relDir}" (absolute path or escapes the repo)`,
    );
  }
  const normalized = path.normalize(relDir);
  const source = path.join(primaryRoot, normalized);
  const sourceStats = await lstat(source).catch(() => null);
  if (!sourceStats) {
    return skip(""); // nothing to link (e.g. dependencies not installed in the primary checkout)
  }

  const dest = path.join(worktreePath, normalized);
  const existing = await lstat(dest).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      return skip("");
    }
    if (existing.isDirectory()) {
      const entries = await readdir(dest);
      if (entries.length > 0) {
        return skip(
          `⚠ left "${normalized}" as-is (already populated in the worktree)`,
        );
      }
      await rmdir(dest);
    } else {
      return skip(`⚠ left "${normalized}" as-is (unexpected non-directory)`);
    }
  }

  await mkdir(path.dirname(dest), { recursive: true });
  // On Windows, directory symlinks require admin privileges or Developer Mode.
  // Junctions achieve the same result without elevated permissions.
  await symlink(
    source,
    dest,
    process.platform === "win32" ? "junction" : "dir",
  );
  return {
    linked: true,
    note: `symlinked ${normalized} from the primary checkout`,
  };
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
  // Skip when the primary checkout has no populated hooks dir (e.g. husky not
  // installed). readdir also fails cleanly when the path is absent or a file,
  // so this doubles as the existence/kind check.
  const entries = await readdir(path.join(primaryRoot, hooksPath)).catch(
    () => [] as string[],
  );
  if (entries.length === 0) {
    return "";
  }
  const { linked, note } = await symlinkDirIntoWorktree(
    primaryRoot,
    worktreePath,
    hooksPath,
  );
  return linked ? `wired git hooks (${hooksPath} → primary checkout)` : note;
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
 *
 * `symlinkDependencies` (opt-in; defaulted off at the tool layer) gates only
 * the dependency-directory symlinks. When true, node_modules is shared from the
 * primary checkout to avoid reinstalling — but a package install in the worktree
 * then writes through to the primary checkout, so worktrees stay isolated unless
 * it is explicitly requested. Returns `linkedDependencies` so the caller can
 * tailor its guidance.
 */
export async function provisionWorktree(params: {
  primaryRoot: string;
  worktreePath: string;
  symlinkDependencies: boolean;
}): Promise<{ notes: string[]; linkedDependencies: boolean }> {
  const { primaryRoot, worktreePath, symlinkDependencies } = params;
  const config = await readProvisionConfig(primaryRoot);
  const notes: string[] = [];
  let linkedDependencies = false;

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

  if (symlinkDependencies) {
    for (const dir of config.symlinkDirectories) {
      await record(async () => {
        const { linked, note } = await symlinkDirIntoWorktree(
          primaryRoot,
          worktreePath,
          dir,
        );
        if (linked) {
          linkedDependencies = true;
        }
        return note;
      });
    }
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

  return { notes, linkedDependencies };
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
  } else {
    await switchCurrentRuntimeWorkingDirectory(worktreePath);
  }
  // Both paths must refresh the captured execution context: the in-flight
  // turn resolves tool cwds from the snapshot taken at turn start, so
  // skipping this leaves every remaining tool call in the previous cwd.
  await updateToolExecutionContextCwd(params.executionContextId, worktreePath);
  return true;
}

// Session-aware orchestration around the cross-agent worktree lock. The pure
// file-backed primitive (acquire/release, ownership, liveness) lives in
// `@/utils/worktree-lock`; the helpers here add git-dir resolution,
// runtime-context ownership, and the user-facing conflict message.

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

function formatLockConflict(lock: WorktreeLock, worktreePath: string): string {
  const since = lock.acquiredAt ? ` since ${lock.acquiredAt}` : "";
  return [
    `Worktree is already in use by another agent (${describeHolder(lock)}${since}).`,
    `Refusing to switch into ${worktreePath} to avoid two agents editing it concurrently.`,
    "If that agent is no longer active, retry with `force: true` to take over the lock.",
  ].join("\n");
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
  managedDir: string;
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

  // Release the lock on the worktree we are leaving. A lock can only ever be
  // held on a managed worktree, so skip the git-dir lookup entirely when the
  // previous cwd is outside `.letta/worktrees/` (the common case: switching in
  // from the main checkout).
  if (isPathWithin(params.previousCwd, params.managedDir)) {
    const previousGitDir = await resolveWorktreeGitDir(params.previousCwd);
    if (previousGitDir && previousGitDir !== targetGitDir) {
      await releaseWorktreeLock({ worktreeGitDir: previousGitDir, owner });
    }
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
  args: EnterWorktreeArgs;
  requestedPath: string;
  runtimeContext: ReturnType<typeof getRuntimeContext>;
}): Promise<EnterWorktreeResult> {
  const { args, requestedPath, runtimeContext } = params;
  const { currentCwd, repoRoot, managedDir } = await resolveWorktreeContext({
    args,
    runtimeContext,
  });

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
      `Refusing to enter ${requestedPath}: only worktrees under ${managedDir} (created by EnterWorktree) can be switched into.`,
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
  // the enter (caught by enter_worktree's handler). When we are not switching
  // the session in, we do not take ownership, so we skip the lock.
  const lockNote = shouldSwitchCwd
    ? await claimWorktreeLock({
        worktreePath: resolvedTarget,
        previousCwd: currentCwd,
        managedDir,
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

export async function enter_worktree(
  rawArgs: Record<string, unknown>,
): Promise<EnterWorktreeResult> {
  if (!isObject(rawArgs)) {
    return {
      content: [{ type: "text", text: "Invalid EnterWorktree arguments" }],
      status: "error",
    };
  }

  const args = rawArgs as unknown as EnterWorktreeArgs;
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

    const { currentCwd, repoRoot, primaryRoot, managedDir } =
      await resolveWorktreeContext({ args, runtimeContext });
    const slug = slugifyName(name);
    const worktreePath = await chooseUniqueWorktreePath(managedDir, slug);
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

    await mkdir(managedDir, { recursive: true });
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
    let linkedDependencies = false;
    try {
      const provisioned = await provisionWorktree({
        primaryRoot,
        worktreePath: normalizedWorktreePath,
        // Opt-in: only share node_modules when explicitly requested, so a
        // worktree stays isolated by default and a package install here cannot
        // write through to the primary checkout's dependencies.
        symlinkDependencies: args.symlink_dependencies === true,
      });
      provisionNotes = provisioned.notes;
      linkedDependencies = provisioned.linkedDependencies;
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
          managedDir,
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
      linkedDependencies,
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
