import path from "node:path";
import { getRuntimeContext } from "@/runtime-context";
import { releaseWorktreeLock } from "@/utils/worktree-lock";
import {
  lockOwner,
  resolveWorktreeGitDir,
  switchSessionToWorktree,
} from "./enter-worktree.js";
import {
  formatGitFailure,
  gitStdout,
  isPathWithin,
  resolveDefaultBaseRef,
  resolvePrimaryWorktreeRoot,
  resolveRepoRoot,
  runGit,
} from "./worktree-git.js";

interface ExitWorktreeArgs {
  action?: string;
  discard_changes?: boolean;
  /** Injected by executeTool so the in-flight turn's cwd snapshot is updated. */
  _executionContextId?: string;
}

interface ExitWorktreeResult {
  content: Array<{ type: string; text: string }>;
  status: "success" | "error";
  returned_to?: string;
  removed?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function textResult(
  text: string,
  status: "success" | "error",
  extra?: Partial<ExitWorktreeResult>,
): ExitWorktreeResult {
  return { content: [{ type: "text", text }], status, ...extra };
}

/**
 * Uncommitted work and commits that exist only on this worktree's branch.
 *
 * Both are checked because they are lost by different mechanisms: `git
 * worktree remove` discards the dirty tree, and deleting the branch orphans
 * its commits. A worktree can be clean and still hold hours of committed work.
 */
async function collectUnsavedWork(
  worktreePath: string,
  repoRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];

  const status = await gitStdout(["status", "--porcelain"], worktreePath);
  if (status) {
    const lines = status.split("\n").filter(Boolean);
    warnings.push(
      `${lines.length} uncommitted change(s):\n${lines
        .slice(0, 10)
        .map((line) => `  ${line}`)
        .join("\n")}${lines.length > 10 ? "\n  ..." : ""}`,
    );
  }

  // Best-effort: if the base ref cannot be resolved we would rather remove
  // without a commit warning than block a legitimate exit on a git edge case.
  try {
    const baseRef = await resolveDefaultBaseRef(repoRoot);
    const unmerged = await gitStdout(
      ["log", "--oneline", `${baseRef}..HEAD`],
      worktreePath,
    );
    if (unmerged) {
      const lines = unmerged.split("\n").filter(Boolean);
      warnings.push(
        `${lines.length} commit(s) not in ${baseRef}:\n${lines
          .slice(0, 10)
          .map((line) => `  ${line}`)
          .join("\n")}${lines.length > 10 ? "\n  ..." : ""}`,
      );
    }
  } catch {
    // Ignore: reported as no unmerged commits.
  }

  return warnings;
}

async function resolveCurrentBranch(
  worktreePath: string,
): Promise<string | null> {
  try {
    const branch = await gitStdout(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      worktreePath,
    );
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Labeled-field result, matching the EnterWorktree message shape so the TUI
 * can render a compact summary instead of the raw tool return.
 */
function buildExitWorktreeMessage(params: {
  removed: boolean;
  worktreePath: string;
  branchNote: string;
  lockNote?: string;
  primaryRoot: string;
  switchedCwd: boolean;
}): string {
  const lines = [
    params.removed ? "Removed worktree." : "Left worktree.",
    "",
    `Path: ${params.worktreePath}`,
    `Branch: ${params.branchNote}`,
  ];
  if (params.lockNote) {
    lines.push(`Lock: ${params.lockNote}`);
  }
  lines.push(
    `CWD: ${params.primaryRoot}`,
    "",
    params.switchedCwd
      ? "This conversation's working directory is now the primary checkout."
      : `⚠ The working directory could not be switched and may still point at ${params.worktreePath}.`,
  );
  if (!params.removed) {
    lines.push(
      "",
      "The worktree and its branch were left on disk; re-enter it with EnterWorktree `path`.",
    );
  }
  return lines.join("\n");
}

/**
 * Leave the worktree this conversation is in and return to the primary
 * checkout, optionally deleting the worktree and its branch.
 *
 * Scope is the *current* working directory rather than a recorded session:
 * EnterWorktree can also switch into a worktree another conversation created,
 * and after a restart there is no in-memory session to consult. If the cwd is
 * not a managed worktree under `.letta/worktrees/`, this is a no-op.
 */
export async function exit_worktree(
  rawArgs: Record<string, unknown>,
): Promise<ExitWorktreeResult> {
  if (!isObject(rawArgs)) {
    return textResult("Invalid ExitWorktree arguments", "error");
  }

  const args = rawArgs as unknown as ExitWorktreeArgs;
  const action = args.action;
  if (action !== "keep" && action !== "remove") {
    return textResult(
      'Provide `action`: "keep" leaves the worktree on disk, "remove" deletes it and its branch.',
      "error",
    );
  }
  const discardChanges = args.discard_changes === true;

  try {
    const runtimeContext = getRuntimeContext();
    const currentCwd =
      runtimeContext?.workingDirectory || process.env.USER_CWD || process.cwd();

    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRoot(currentCwd);
    } catch {
      return textResult(
        `Not inside a git repository: ${currentCwd}\nNo worktree session to exit.`,
        "success",
      );
    }

    const primaryRoot = await resolvePrimaryWorktreeRoot(repoRoot);
    const managedDir = path.join(primaryRoot, ".letta", "worktrees");

    if (!isPathWithin(currentCwd, managedDir)) {
      return textResult(
        [
          `Not in a managed worktree (current directory: ${currentCwd}).`,
          "ExitWorktree only applies to worktrees under .letta/worktrees/; nothing to do.",
        ].join("\n"),
        "success",
      );
    }

    // The worktree root, not the cwd, which may be a subdirectory of it.
    const worktreePath = repoRoot;
    const branchName = await resolveCurrentBranch(worktreePath);

    if (action === "remove" && !discardChanges) {
      const unsaved = await collectUnsavedWork(worktreePath, repoRoot);
      if (unsaved.length > 0) {
        return textResult(
          [
            `Refusing to remove ${worktreePath} — it still holds work:`,
            "",
            ...unsaved,
            "",
            'Commit or push it, exit with `action: "keep"`, or re-run with `discard_changes: true` to delete it anyway.',
          ].join("\n"),
          "error",
        );
      }
    }

    // Leave before removing. `git worktree remove` deletes the directory the
    // session (and any persistent shell) is sitting in, which strands the cwd
    // and wedges later commands — see letta-ai/letta-code#3253.
    const switchedCwd = await switchSessionToWorktree({
      worktreePath: primaryRoot,
      shouldSwitchCwd: true,
      runtimeContext,
      executionContextId: args._executionContextId,
    });

    let lockNote: string | undefined;
    const worktreeGitDir = await resolveWorktreeGitDir(worktreePath);
    if (worktreeGitDir) {
      const released = await releaseWorktreeLock({
        worktreeGitDir,
        owner: lockOwner(runtimeContext),
      });
      if (released) {
        lockNote = "released";
      }
    }

    let removed = false;
    let branchNote = branchName ?? "(detached)";
    if (action === "remove") {
      const removeArgs = ["worktree", "remove", worktreePath];
      if (discardChanges) {
        removeArgs.push("--force");
      }
      await runGit(removeArgs, primaryRoot);
      removed = true;

      if (branchName) {
        try {
          await runGit(
            ["branch", discardChanges ? "-D" : "-d", branchName],
            primaryRoot,
          );
          branchNote = `deleted ${branchName}`;
        } catch (error) {
          // The worktree is already gone; surface the branch as a leftover
          // rather than failing an otherwise completed removal.
          branchNote = `⚠ kept ${branchName} (${formatGitFailure(error)})`;
        }
      }
    }

    const message = buildExitWorktreeMessage({
      removed,
      worktreePath,
      branchNote,
      lockNote,
      primaryRoot,
      switchedCwd,
    });

    return textResult(message, "success", {
      returned_to: primaryRoot,
      removed,
    });
  } catch (error) {
    return textResult(`Error: ${formatGitFailure(error)}`, "error");
  }
}
