/**
 * Git and path plumbing shared by the worktree tools.
 *
 * EnterWorktree and ExitWorktree both need to shell out to git, classify its
 * failures, and locate the primary checkout. Keeping that here lets each tool
 * module stay focused on its own flow instead of one importing internals of
 * the other.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { getShellEnv } from "./shell-env.js";

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

export async function runGit(
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
  return await gitStdout(["rev-parse", "--show-toplevel"], cwd);
}

export async function resolvePrimaryWorktreeRoot(
  repoRoot: string,
): Promise<string> {
  const commonDir = await gitStdout(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    repoRoot,
  );
  return path.basename(commonDir) === ".git"
    ? path.dirname(commonDir)
    : repoRoot;
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
