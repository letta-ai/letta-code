/**
 * Git and path plumbing shared by the worktree tools.
 *
 * EnterWorktree and ExitWorktree both need to shell out to git, classify its
 * failures, and locate the primary checkout. Keeping that here lets each tool
 * module stay focused on its own flow instead of one importing internals of
 * the other.
 */

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
