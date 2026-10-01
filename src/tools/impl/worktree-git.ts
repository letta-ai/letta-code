/**
 * Git and path plumbing shared by the worktree tools.
 *
 * EnterWorktree and ExitWorktree both need to shell out to git, classify its
 * failures, and locate the primary checkout. Keeping that here lets each tool
 * module stay focused on its own flow instead of one importing internals of
 * the other.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getShellEnv } from "./shell-env.js";
import { spawnWithLauncher } from "./shell-runner.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;

export type GitResult = {
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

export function formatGitFailure(error: unknown): string {
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

export function buildNonInteractiveGitEnv(
  base: NodeJS.ProcessEnv = getShellEnv(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
  };
  // OpenSSH can bypass closed stdin and read a passphrase from /dev/tty.
  const sshCommand = env.GIT_SSH_COMMAND?.trim() || "ssh";
  env.GIT_SSH_COMMAND = `${sshCommand} -o BatchMode=yes`;
  return env;
}

export async function runGit(
  args: string[],
  cwd: string,
  options: {
    timeoutMs?: number;
    allowFailure?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  let result: GitResult;
  try {
    result = await spawnWithLauncher(["git", ...args], {
      cwd,
      env: buildNonInteractiveGitEnv(),
      signal: options.signal,
      timeoutMs,
    });
  } catch (error) {
    const failure = error as Error & {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      code?: number | null;
    };
    throw new GitCommandError(
      failure.killed
        ? `Timed out running git ${args.join(" ")}`
        : `Failed to run git ${args.join(" ")}: ${failure.message}`,
      args,
      {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : null,
      },
    );
  }

  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitCommandError(
      `Failed to run git ${args.join(" ")}`,
      args,
      result,
    );
  }

  return result;
}

export async function gitStdout(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  return result.stdout.trim();
}

export async function gitRefExists(cwd: string, ref: string): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", "--quiet", ref], cwd, {
    allowFailure: true,
  });
  return result.exitCode === 0;
}

// Each key shape is written once and shared by the `git config --get-regexp`
// scan and the classification below, so the two cannot drift apart.
const INCLUDE_IF_KEY = "includeif\\..*";
const FILTER_DRIVER_KEY = "filter\\.(.*)\\.(clean|smudge|process|required)";
const LFS_PROGRAM_KEY =
  "lfs\\.customtransfer\\..*\\.path|lfs\\.standalonetransferagent";
const WORKTREE_UNSAFE_CONFIG_PATTERN = `^(${INCLUDE_IF_KEY}|${FILTER_DRIVER_KEY}|${LFS_PROGRAM_KEY})$`;
const INCLUDE_IF_KEY_PATTERN = new RegExp(`^(${INCLUDE_IF_KEY})$`, "i");
const FILTER_DRIVER_KEY_PATTERN = new RegExp(`^${FILTER_DRIVER_KEY}$`, "i");
const LFS_PROGRAM_KEY_PATTERN = new RegExp(`^(${LFS_PROGRAM_KEY})$`, "i");

type GitConfigScope = "--local" | "--worktree";

/** Runs a read-only `git config` query; null means nothing matched. */
async function queryRepoConfig(
  cwd: string,
  args: string[],
): Promise<string | null> {
  const result = await runGit(["config", ...args], cwd, {
    allowFailure: true,
  });
  if (result.exitCode === 1 && !result.stdout) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read the repository git config to neutralize filter drivers: ${result.stderr.trim() || `git config exited ${result.exitCode}`}`,
    );
  }
  return result.stdout;
}

async function listUnsafeConfigKeysInScope(
  cwd: string,
  scope: GitConfigScope,
): Promise<string[]> {
  const stdout = await queryRepoConfig(cwd, [
    scope,
    "--includes",
    "--null",
    "--name-only",
    "--get-regexp",
    WORKTREE_UNSAFE_CONFIG_PATTERN,
  ]);
  return stdout?.split("\0").filter(Boolean) ?? [];
}

/**
 * Git honors `extensions.worktreeConfig` only from the repository config file
 * itself, so this deliberately reads it without following includes.
 */
async function isWorktreeConfigEnabled(cwd: string): Promise<boolean> {
  const stdout = await queryRepoConfig(cwd, [
    "--local",
    "--type=bool",
    "--get",
    "extensions.worktreeConfig",
  ]);
  return stdout?.trim() === "true";
}

async function listWorktreeUnsafeConfigKeys(cwd: string): Promise<string[]> {
  const keys = await listUnsafeConfigKeysInScope(cwd, "--local");
  // `git worktree add` copies this worktree's config.worktree into the new
  // worktree before checkout, and `--local` never reads that file. Asking for
  // `--worktree` without the extension dies in multi-worktree repositories.
  if (await isWorktreeConfigEnabled(cwd)) {
    keys.push(...(await listUnsafeConfigKeysInScope(cwd, "--worktree")));
  }
  return keys;
}

/**
 * Creates a worktree without executing commands planted inside the repository's
 * git directory: checkout filters from repository-local or worktree-scoped git
 * config, the `core.fsmonitor` command, and hooks such as post-checkout. An
 * agent can write those files, so letting them run during `git worktree add`
 * would bypass the normal shell permission path. Config shapes that cannot be
 * safely overridden fail closed.
 */
export async function addWorktreeSafely(params: {
  repoRoot: string;
  branchName: string;
  worktreePath: string;
  baseRef: string;
}): Promise<void> {
  const keys = await listWorktreeUnsafeConfigKeys(params.repoRoot);
  if (keys.some((key) => INCLUDE_IF_KEY_PATTERN.test(key))) {
    throw new Error(
      "The repository git config has a conditional include (includeIf), so its checkout filters cannot be neutralized safely.",
    );
  }

  const blockedLfsKey = keys.find((key) => LFS_PROGRAM_KEY_PATTERN.test(key));
  if (blockedLfsKey) {
    throw new Error(
      `Git was not run: the repository's own git config sets ${blockedLfsKey}. Move trusted Git LFS transfer programs to global git config, or remove the setting and retry.`,
    );
  }

  const driverNames = new Set<string>();
  for (const key of keys) {
    const driverName = FILTER_DRIVER_KEY_PATTERN.exec(key)?.[1];
    if (!driverName) {
      // The scan reported a key nothing above knows how to switch off.
      throw new Error(
        `The repository git config sets ${key}, which cannot be neutralized safely.`,
      );
    }
    if (/[=\r\n]/.test(driverName)) {
      throw new Error(
        'The repository git config defines a filter driver whose name cannot be neutralized (contains "=" or a newline).',
      );
    }
    driverNames.add(driverName);
  }

  const filterOverrides = [...driverNames]
    .sort()
    .flatMap((driverName) => [
      "-c",
      `filter.${driverName}.clean=`,
      "-c",
      `filter.${driverName}.smudge=`,
      "-c",
      `filter.${driverName}.process=`,
      "-c",
      `filter.${driverName}.required=false`,
    ]);
  // An empty directory is the portable way to say "no hooks": /dev/null is not
  // a path Git for Windows resolves.
  const emptyHooksDir = await mkdtemp(
    path.join(tmpdir(), "letta-worktree-no-hooks-"),
  );
  try {
    await runGit(
      [
        ...filterOverrides,
        "-c",
        `core.hooksPath=${emptyHooksDir}`,
        "-c",
        "core.fsmonitor=false",
        "worktree",
        "add",
        "--no-track",
        "-b",
        params.branchName,
        params.worktreePath,
        params.baseRef,
      ],
      params.repoRoot,
    );
  } finally {
    await rm(emptyHooksDir, { recursive: true, force: true });
  }
}

export async function resolveRepoRoot(cwd: string): Promise<string> {
  const repoRoot = await gitStdout(["rev-parse", "--show-toplevel"], cwd);
  return path.resolve(repoRoot);
}

export async function resolvePrimaryWorktreeRoot(
  repoRoot: string,
): Promise<string> {
  const commonDir = await gitStdout(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot,
  );
  const primaryRoot =
    path.basename(commonDir) === ".git" ? path.dirname(commonDir) : repoRoot;
  return path.resolve(primaryRoot);
}

export async function resolveDefaultBaseRef(repoRoot: string): Promise<string> {
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

export function isPathWithin(child: string, parent: string): boolean {
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent + path.sep)
  );
}
