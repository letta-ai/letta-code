import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { syncPendingMemoryCommitsAfterTurn } from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentResult } from ".";

async function git(memoryDir: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    ...args,
  ]);
  return stdout.trim();
}

/** Paths with uncommitted changes, keyed so a rename counts by its new name. */
async function dirtyPaths(memoryDir: string): Promise<Map<string, string>> {
  const { stdout } = await promisify(execFile)("git", [
    "-C",
    memoryDir,
    "status",
    "--porcelain",
    "-z",
  ]);
  const entries = new Map<string, string>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    const code = token.slice(0, 2);
    entries.set(token.slice(3), code);
    // Renames and copies carry the original path as the next token.
    if (code.startsWith("R") || code.startsWith("C")) index++;
  }
  return entries;
}

/**
 * Undo the uncommitted changes a cancelled worker introduced. Paths that were
 * already dirty before it started are left alone: they may belong to the
 * primary agent.
 */
async function discardNewChanges(
  memoryDir: string,
  before: Map<string, string>,
): Promise<void> {
  const introduced = (entries: Map<string, string>) =>
    [...entries].filter(([path]) => !before.has(path));
  // Unstage first: a file the worker added becomes untracked and is removed
  // below, while a modified tracked file is restored from HEAD.
  const staged = introduced(await dirtyPaths(memoryDir)).map(([path]) => path);
  if (staged.length > 0) {
    await git(memoryDir, ["reset", "-q", "--", ...staged]).catch(() => {});
  }
  const untracked: string[] = [];
  const modified: string[] = [];
  for (const [path, code] of introduced(await dirtyPaths(memoryDir))) {
    (code === "??" ? untracked : modified).push(path);
  }
  if (modified.length > 0) {
    await git(memoryDir, ["checkout", "-q", "--", ...modified]).catch(() => {});
  }
  for (const path of untracked) {
    await rm(join(memoryDir, path), { recursive: true, force: true });
  }
}

/** Called inside the existing background task, never awaited by the primary. */
export async function runMemoryWorker(
  params: {
    agentId: string;
    conversationId: string;
    memoryDir: string;
    signal?: AbortSignal;
  },
  execute: () => Promise<SubagentResult>,
  deps: {
    sync?: typeof syncPendingMemoryCommitsAfterTurn;
    recompile?: typeof recompileAgentSystemPrompt;
    /** Memory on disk changed (a local commit, a push, or a pull); refresh readers. */
    onMemoryChanged?: () => void;
  } = {},
): Promise<SubagentResult> {
  const head = () =>
    git(params.memoryDir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(
      () => "",
    );
  return withMemoryOperation(
    params.memoryDir,
    async () => {
      const headBefore = await head();
      const dirtyBefore = await dirtyPaths(params.memoryDir);
      let result: SubagentResult;
      let syncError: string | undefined;
      let synced = false;
      try {
        result = await execute();
      } finally {
        if (params.signal?.aborted) {
          // A cancelled worker must not leave half-edited files for the next
          // session to find, and its sync (with remote retries) must not hold
          // the exit. Whatever it already committed stays for the next sync.
          await discardNewChanges(params.memoryDir, dirtyBefore).catch(
            (error) => {
              debugWarn("memory-worker", `Rollback failed: ${String(error)}`);
            },
          );
        } else {
          // Normal sync owns Git status checks and remote retries.
          try {
            const syncResult = await (
              deps.sync ?? syncPendingMemoryCommitsAfterTurn
            )(params.agentId, { memoryDir: params.memoryDir });
            if (
              syncResult.status === "clean" ||
              syncResult.status === "pushed" ||
              syncResult.status === "skipped"
            ) {
              synced = true;
            } else {
              syncError = `Memory sync incomplete (${syncResult.status}): ${syncResult.summary}`;
              debugWarn("memory-worker", syncError);
            }
          } catch (error) {
            syncError = `Memory sync failed: ${String(error)}`;
            debugWarn("memory-worker", syncError);
          }
          // Local-only checkouts report "skipped" after a commit; readers still
          // need to know memory changed.
          if ((await head()) !== headBefore) deps.onMemoryChanged?.();
        }
      }
      // Memory is committed and synced at this point; a failed prompt refresh
      // is worth a warning but must not report the worker as failed. Running
      // it under the checkout lock is safe because the primary's tools never
      // take this lock, so its active turn cannot be waiting on us.
      if (synced) {
        try {
          if (deps.recompile || getBackend().capabilities.promptRecompile) {
            await (deps.recompile ?? recompileAgentSystemPrompt)(
              params.conversationId,
              params.agentId,
            );
          }
        } catch (error) {
          debugWarn(
            "memory-worker",
            `System prompt recompile failed after memory sync: ${String(error)}`,
          );
        }
      }
      return syncError
        ? { ...result, success: false, error: result.error ?? syncError }
        : result;
    },
    params.signal,
  );
}
