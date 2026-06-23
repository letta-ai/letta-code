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
  switchConversationWorkingDirectory,
  switchCurrentRuntimeWorkingDirectory,
} from "@/websocket/listener/cwd-change";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { restartWorktreeWatcher } from "@/websocket/listener/worktree-watcher";
import { getShellEnv } from "./shell-env.js";
import { validateRequiredParams } from "./validation.js";

interface CreateWorktreeArgs {
  name: string;
  branch_name?: string;
  base_ref?: string;
  repo_path?: string;
  refresh_base?: boolean;
  switch_cwd?: boolean;
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

export async function create_worktree(
  rawArgs: Record<string, unknown>,
): Promise<CreateWorktreeResult> {
  validateRequiredParams(rawArgs, ["name"], "CreateWorktree");
  if (!isObject(rawArgs)) {
    return {
      content: [{ type: "text", text: "Invalid CreateWorktree arguments" }],
      status: "error",
    };
  }

  const args = rawArgs as unknown as CreateWorktreeArgs;
  const name = getStringArg(args, "name");
  if (!name) {
    return {
      content: [{ type: "text", text: "Worktree name cannot be empty" }],
      status: "error",
    };
  }

  try {
    const runtimeContext = getRuntimeContext();
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
    let switchedCwd = false;

    if (shouldSwitchCwd) {
      const listener = getActiveRuntime();
      if (listener && runtimeContext?.conversationId) {
        await switchConversationWorkingDirectory({
          runtime: listener,
          agentId: runtimeContext.agentId ?? null,
          conversationId: runtimeContext.conversationId,
          workingDirectory: normalizedWorktreePath,
          updateCurrentRuntimeContext: true,
        });
        switchedCwd = true;
        restartWorktreeWatcher({
          runtime: listener,
          agentId: runtimeContext.agentId ?? null,
          conversationId: runtimeContext.conversationId,
        });
      } else {
        await switchCurrentRuntimeWorkingDirectory(normalizedWorktreePath);
        const executionContextId = getStringArg(args, "_executionContextId");
        if (executionContextId) {
          const { updateToolExecutionContextWorkingDirectory } = await import(
            "@/tools/manager"
          );
          updateToolExecutionContextWorkingDirectory(
            executionContextId,
            normalizedWorktreePath,
          );
        }
        switchedCwd = true;
      }
    }

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
