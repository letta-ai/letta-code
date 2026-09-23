import { syncPendingMemoryCommitsAfterTurn } from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  integrateMemoryWorkerWorktree,
} from "@/agent/memory-worktree";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentMemoryScope, SubagentResult } from ".";

/**
 * Run a memory worker under the checkout lease. The worker edits a private
 * worktree of the memory repository, so the primary agent's own edits to the
 * checkout are never touched: a cancelled worker is discarded outright, and a
 * finished worker's commits are merged back before the lease is released. A
 * merge that conflicts with the primary's changes keeps the worker's branch
 * and reports it instead of guessing.
 *
 * Called inside the existing background task, never awaited by the primary.
 */
export async function runMemoryWorker(
  params: {
    agentId: string;
    conversationId: string;
    memoryDir: string;
    signal?: AbortSignal;
  },
  execute: (
    memoryDir: string,
    memoryScope: SubagentMemoryScope,
  ) => Promise<SubagentResult>,
  deps: {
    sync?: typeof syncPendingMemoryCommitsAfterTurn;
    recompile?: typeof recompileAgentSystemPrompt;
    /** Memory on disk changed (a merge, a push, or a pull); refresh readers. */
    onMemoryChanged?: () => void;
  } = {},
): Promise<SubagentResult> {
  return withMemoryOperation(
    params.memoryDir,
    async () => {
      const worktree = await createReflectionMemoryWorktree({
        parentMemoryDir: params.memoryDir,
        label: "memory-worker",
      });
      let result: SubagentResult;
      try {
        result = await execute(
          worktree.worktreeDir,
          buildReflectionMemoryScope(worktree),
        );
      } catch (error) {
        // A worker that crashed after committing still has commits worth
        // keeping; they are merged and synced below and the task reports
        // the failure, rather than silently leaving an unsynced checkout.
        result = {
          agentId: "",
          success: false,
          report: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      // A cancelled worker's edits are dropped with its worktree; nothing it
      // did reaches the checkout, and no sync (with remote retries) runs.
      const outcome = await integrateMemoryWorkerWorktree(worktree, {
        discard: params.signal?.aborted === true,
      });
      if (outcome.status === "discarded") {
        return {
          ...result,
          success: false,
          error: result.error ?? "Memory worker cancelled",
        };
      }
      if (outcome.status === "merge_conflict") {
        return {
          ...result,
          success: false,
          error:
            result.error ??
            `Memory changes conflict with the checkout; ${outcome.commitCount} commit(s) kept on ${outcome.branchName}`,
        };
      }
      if (outcome.status === "failed") {
        return {
          ...result,
          success: false,
          error: result.error ?? outcome.error,
        };
      }
      let syncError: string | undefined;
      let synced = false;
      let pushed = false;
      // Normal sync owns Git status checks and remote retries.
      try {
        const syncResult = await (
          deps.sync ?? syncPendingMemoryCommitsAfterTurn
        )(params.agentId, { memoryDir: params.memoryDir });
        pushed = syncResult.status === "pushed";
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
      // Local-only checkouts report a merge as "skipped"; readers still need
      // to know memory changed.
      if (pushed || outcome.status === "merged") deps.onMemoryChanged?.();
      // Memory is committed and synced at this point; a failed prompt refresh
      // is worth a warning but must not report the worker as failed. Running
      // it under the checkout lock is safe because the primary's tools never
      // take this lock, so its active turn cannot be waiting on us.
      if (synced && outcome.status === "merged" && result.success) {
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
