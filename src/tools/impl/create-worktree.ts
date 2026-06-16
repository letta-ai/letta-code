import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getRuntimeContext } from "@/runtime-context";
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
    return detail ? `${error.message}\n${detail}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
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
}): string {
  const lines = [
    "Created worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchName}`,
    `Base: ${params.baseRef}`,
    "",
    params.switchedCwd
      ? "This conversation's working directory is now the new worktree."
      : "The conversation working directory was left unchanged.",
    "",
    "Next steps:",
    "- Confirm you are in the new worktree with `git status` before editing.",
    "- Read README, AGENTS.md, or other project setup docs before running commands.",
    "- If this repo needs per-worktree dependency setup, install dependencies with the project's package manager. Check the repo first: if it uses Bun, run `bun install` instead of `npm install`; if it uses pnpm, yarn, or npm, use that package manager instead.",
    "- If the repo uses git hooks, verify they are installed and active in this worktree before committing; run the project's documented hook setup if needed.",
    "- Then make changes, test, commit, and push from this worktree.",
  ];
  return lines.join("\n");
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
    await runGit(
      ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      repoRoot,
    );

    const normalizedWorktreePath = path.normalize(await realpath(worktreePath));
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
