import {
  clearMemoryConflictRepair,
  completeMemoryConflictRepair,
} from "@/agent/memory-conflict-repair";
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
    /**
     * Set for a harness-launched conflict repair: the attempt token from
     * `claimMemoryConflictRepair`, which the worker advances or forgets.
     */
    repairToken?: string;
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
  const helpers = { sync, recompile, deps };
  const { repairToken } = params;
  if (repairToken === undefined) {
    return withMemoryOperation(
      params.memoryDir,
      () => runUpdate(params, execute, helpers),
      params.signal,
    );
  }
  try {
    return await withMemoryOperation(
      params.memoryDir,
      () => runRepair(params, repairToken, execute, helpers),
      params.signal,
    );
  } catch (error) {
    // Nothing ran: a failure anywhere in the leased run, or cancellation while
    // still waiting for the lease. Forget this attempt so the next turn
    // retries instead of waiting for this process to exit.
    await clearMemoryConflictRepair(params.memoryDir, repairToken);
    throw error;
  }
}

type Helpers = {
  sync: () => Promise<MemoryPostTurnSyncResult>;
  recompile: () => Promise<void>;
  deps: Parameters<typeof runMemoryWorker>[2];
};

function syncSummary(result: MemoryPostTurnSyncResult): string {
  return `Memory sync incomplete (${result.status}): ${result.summary}`;
}

/**
 * Sync the checkout after a worker changed it, tell readers when memory
 * changed, refresh the parent's prompt on success, and fold a sync problem
 * into the worker's result. Shared by update and repair workers.
 */
async function settle(
  result: SubagentResult,
  changed: boolean,
  { sync, recompile, deps }: Helpers,
): Promise<SubagentResult> {
  let syncError: string | undefined;
  let pushed = false;
  // Normal sync owns Git status checks and remote retries.
  try {
    const syncResult = await sync();
    pushed = syncResult.status === "pushed";
    if (!SYNCED_STATUSES.has(syncResult.status)) {
      syncError = syncSummary(syncResult);
      debugWarn("memory-worker", syncError);
      if (syncResult.status === "conflict") await deps?.repair?.(syncResult);
    }
  } catch (error) {
    syncError = `Memory sync failed: ${String(error)}`;
    debugWarn("memory-worker", syncError);
  }
  // Local-only checkouts report a merge as "skipped"; readers still need to
  // know memory changed.
  if (pushed || changed) deps?.onMemoryChanged?.();
  if (!syncError && changed && result.success) await recompile();
  return syncError
    ? { ...result, success: false, error: result.error ?? syncError }
    : result;
}

async function runUpdate(
  params: Parameters<typeof runMemoryWorker>[0],
  execute: Parameters<typeof runMemoryWorker>[1],
  helpers: Helpers,
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
  const failed = (error: string) => ({
    ...result,
    success: false,
    error: result.error ?? error,
  });
  switch (outcome.status) {
    case "discarded":
      return failed("Memory worker cancelled");
    case "merge_conflict":
      return failed(
        `Memory changes conflict with the checkout; ${outcome.commitCount} commit(s) kept on ${outcome.branchName}`,
      );
    case "failed":
      return failed(outcome.error);
    default:
      return settle(result, outcome.status === "merged", helpers);
  }
}

/**
 * Repair works on the checkout itself, where the unfinished Git operation
 * lives. The attempt marker that keeps the same conflict from being retried
 * every turn is advanced here, under the lease: forgotten if the worker never
 * ran (nothing left to repair, cancellation) so the next turn retries, marked
 * done once it has run so an unresolved conflict is reported instead.
 */
async function runRepair(
  params: Parameters<typeof runMemoryWorker>[0],
  token: string,
  execute: Parameters<typeof runMemoryWorker>[1],
  helpers: Helpers,
): Promise<SubagentResult> {
  // Another worker, or the primary, may have repaired the checkout before
  // this one acquired it. Only a clean sync is a no-op; a dirty or unpushed
  // checkout is reported, not silently declared repaired. Either way the
  // attempt is forgotten: the same operation, if aborted and retried, gets a
  // fresh repair rather than being suppressed while this process lives.
  const state = await helpers.sync();
  if (state.status !== "conflict") {
    await clearMemoryConflictRepair(params.memoryDir, token);
    if (state.status === "pushed") helpers.deps?.onMemoryChanged?.();
    // No worker ran, so there is no worker identity to report.
    return SYNCED_STATUSES.has(state.status)
      ? { agentId: "", success: true, report: "No memory conflict remains." }
      : { agentId: "", success: false, report: "", error: syncSummary(state) };
  }
  const result = await execute(params.memoryDir, {
    primaryRoot: params.memoryDir,
    writableRoots: [params.memoryDir],
  });
  if (params.signal?.aborted) {
    await clearMemoryConflictRepair(params.memoryDir, token);
    return {
      ...result,
      success: false,
      error: result.error ?? "Memory repair cancelled",
    };
  }
  await completeMemoryConflictRepair(params.memoryDir, token);
  return settle(result, true, helpers);
}
