import {
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  integrateMemoryWorkerWorktree,
  type MemoryWorkerWorktreeOutcome,
} from "@/agent/memory-worktree";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentMemoryScope, SubagentResult } from ".";

const SYNCED_STATUSES = new Set<MemoryPostTurnSyncResult["status"]>([
  "clean",
  "pushed",
  "skipped",
]);

/**
 * Run a memory worker under the checkout lease.
 *
 * An update worker edits a private worktree of the memory repository, so the
 * primary agent's own edits to the checkout are never touched: a cancelled
 * worker is discarded outright, and a finished worker's commits are merged
 * back before the lease is released. A merge that conflicts with the
 * primary's changes keeps the worker's branch and reports it instead of
 * guessing. A repair worker must work on the checkout itself, where the
 * unfinished Git operation lives.
 *
 * Called inside the existing background task, never awaited by the primary.
 */
export async function runMemoryWorker(
  params: {
    agentId: string;
    conversationId: string;
    memoryDir: string;
    repairOnly?: boolean;
    signal?: AbortSignal;
  },
  execute: (
    memoryDir: string,
    memoryScope: SubagentMemoryScope,
  ) => Promise<SubagentResult>,
  deps: {
    sync?: typeof syncPendingMemoryCommitsAfterTurn;
    recompile?: typeof recompileAgentSystemPrompt;
    /** Awaited so the repair task is registered before this worker completes. */
    repair?: (result: MemoryPostTurnSyncResult) => void | Promise<unknown>;
    /** Memory on disk changed (a merge, a push, or a pull); refresh readers. */
    onMemoryChanged?: () => void;
  } = {},
): Promise<SubagentResult> {
  const sync = () =>
    (deps.sync ?? syncPendingMemoryCommitsAfterTurn)(params.agentId, {
      memoryDir: params.memoryDir,
    });
  const recompile = async () => {
    // Memory is committed and synced at this point; a failed prompt refresh
    // is worth a warning but must not report the worker as failed. Running
    // it under the checkout lock is safe because the primary's tools never
    // take this lock, so its active turn cannot be waiting on us.
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
  };
  return withMemoryOperation(
    params.memoryDir,
    async () =>
      params.repairOnly
        ? runRepair(params, execute, { sync, recompile, deps })
        : runUpdate(params, execute, { sync, recompile, deps }),
    params.signal,
  );
}

type Helpers = {
  sync: () => Promise<MemoryPostTurnSyncResult>;
  recompile: () => Promise<void>;
  deps: Parameters<typeof runMemoryWorker>[2];
};

async function runUpdate(
  params: Parameters<typeof runMemoryWorker>[0],
  execute: Parameters<typeof runMemoryWorker>[1],
  { sync, recompile, deps }: Helpers,
): Promise<SubagentResult> {
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
    // keeping; they are merged and synced below and the task reports the
    // failure, rather than silently leaving an unsynced checkout.
    result = {
      agentId: "",
      success: false,
      report: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // A cancelled worker's edits are dropped with its worktree; nothing it did
  // reaches the checkout, and no sync (with remote retries) runs.
  const outcome: MemoryWorkerWorktreeOutcome =
    await integrateMemoryWorkerWorktree(worktree, {
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
    return { ...result, success: false, error: result.error ?? outcome.error };
  }
  let syncError: string | undefined;
  let pushed = false;
  // Normal sync owns Git status checks and remote retries.
  try {
    const syncResult = await sync();
    pushed = syncResult.status === "pushed";
    if (!SYNCED_STATUSES.has(syncResult.status)) {
      syncError = `Memory sync incomplete (${syncResult.status}): ${syncResult.summary}`;
      debugWarn("memory-worker", syncError);
      if (syncResult.status === "conflict") await deps?.repair?.(syncResult);
    }
  } catch (error) {
    syncError = `Memory sync failed: ${String(error)}`;
    debugWarn("memory-worker", syncError);
  }
  // Local-only checkouts report a merge as "skipped"; readers still need to
  // know memory changed.
  if (pushed || outcome.status === "merged") deps?.onMemoryChanged?.();
  if (!syncError && outcome.status === "merged" && result.success) {
    await recompile();
  }
  return syncError
    ? { ...result, success: false, error: result.error ?? syncError }
    : result;
}

async function runRepair(
  params: Parameters<typeof runMemoryWorker>[0],
  execute: Parameters<typeof runMemoryWorker>[1],
  { sync, recompile, deps }: Helpers,
): Promise<SubagentResult> {
  // Another worker may have repaired the checkout before this one acquired
  // it. Only a clean sync is a no-op; a dirty or unpushed checkout is
  // reported, not silently declared repaired.
  const state = await sync();
  if (state.status !== "conflict") {
    if (state.status === "pushed") deps?.onMemoryChanged?.();
    // No worker ran, so there is no worker identity to report.
    return SYNCED_STATUSES.has(state.status)
      ? { agentId: "", success: true, report: "No memory conflict remains." }
      : {
          agentId: "",
          success: false,
          report: "",
          error: `Memory sync incomplete (${state.status}): ${state.summary}`,
        };
  }
  const result = await execute(params.memoryDir, {
    primaryRoot: params.memoryDir,
    writableRoots: [params.memoryDir],
  });
  if (params.signal?.aborted) return result;
  let syncError: string | undefined;
  let pushed = false;
  try {
    const syncResult = await sync();
    pushed = syncResult.status === "pushed";
    if (!SYNCED_STATUSES.has(syncResult.status)) {
      syncError = `Memory sync incomplete (${syncResult.status}): ${syncResult.summary}`;
      debugWarn("memory-worker", syncError);
    }
  } catch (error) {
    syncError = `Memory sync failed: ${String(error)}`;
    debugWarn("memory-worker", syncError);
  }
  if (pushed || !syncError) deps?.onMemoryChanged?.();
  if (!syncError) await recompile();
  return syncError
    ? { ...result, success: false, error: result.error ?? syncError }
    : result;
}
