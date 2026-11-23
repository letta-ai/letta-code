import {
  clearMemoryConflictRepair,
  completeMemoryConflictRepair,
} from "@/agent/memory-conflict-repair";
import {
  type MemoryPostTurnSyncResult,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { withMemoryOperation } from "@/agent/memory-operation";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { debugWarn } from "@/utils/debug";
import type { SubagentMemoryScope, SubagentResult } from ".";

const SYNCED_STATUSES = new Set<MemoryPostTurnSyncResult["status"]>([
  "clean",
  "pushed",
  "skipped",
]);

interface MemoryWorkerParams {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  repairToken: string;
  signal?: AbortSignal;
}

type MemoryWorkerExecute = (
  memoryDir: string,
  memoryScope: SubagentMemoryScope,
) => Promise<SubagentResult>;

interface MemoryWorkerDeps {
  sync?: typeof syncPendingMemoryCommitsAfterTurn;
  recompile?: typeof recompileAgentSystemPrompt;
  repair?: (result: MemoryPostTurnSyncResult) => void | Promise<unknown>;
  onMemoryChanged?: () => void;
}

type Helpers = Pick<MemoryWorkerDeps, "repair" | "onMemoryChanged"> & {
  sync: () => Promise<MemoryPostTurnSyncResult>;
  recompile: () => Promise<void>;
};

function failed(result: SubagentResult, error: string): SubagentResult {
  return { ...result, success: false, error: result.error ?? error };
}

const NO_WORKER: SubagentResult = { agentId: "", success: false, report: "" };

export async function runMemoryWorker(
  params: MemoryWorkerParams,
  execute: MemoryWorkerExecute,
  deps: MemoryWorkerDeps = {},
): Promise<SubagentResult> {
  const sync = () =>
    (deps.sync ?? syncPendingMemoryCommitsAfterTurn)(params.agentId, {
      memoryDir: params.memoryDir,
    });
  const recompile = async () => {
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
  const helpers: Helpers = {
    sync,
    recompile,
    repair: deps.repair,
    onMemoryChanged: deps.onMemoryChanged,
  };
  const { repairToken } = params;
  try {
    return await withMemoryOperation(
      params.memoryDir,
      () => runRepair(params, repairToken, execute, helpers),
      params.signal,
    );
  } catch (error) {
    await clearMemoryConflictRepair(params.memoryDir, repairToken);
    throw error;
  }
}

function syncSummary(result: MemoryPostTurnSyncResult): string {
  return `Memory sync incomplete (${result.status}): ${result.summary}`;
}

async function settle(
  result: SubagentResult,
  changed: boolean,
  { sync, recompile, repair, onMemoryChanged }: Helpers,
): Promise<SubagentResult> {
  let syncError: string | undefined;
  let pushed = false;
  try {
    const syncResult = await sync();
    pushed = syncResult.status === "pushed";
    if (!SYNCED_STATUSES.has(syncResult.status)) {
      syncError = syncSummary(syncResult);
      debugWarn("memory-worker", syncError);
      if (syncResult.status === "conflict" || syncResult.status === "invalid")
        await repair?.(syncResult);
    }
  } catch (error) {
    syncError = `Memory sync failed: ${String(error)}`;
    debugWarn("memory-worker", syncError);
  }
  if (pushed || changed) onMemoryChanged?.();
  if (!syncError && changed && result.success) await recompile();
  return syncError ? failed(result, syncError) : result;
}

async function runRepair(
  params: MemoryWorkerParams,
  token: string,
  execute: MemoryWorkerExecute,
  helpers: Helpers,
): Promise<SubagentResult> {
  const state = await helpers.sync();
  if (state.status !== "conflict" && state.status !== "invalid") {
    await clearMemoryConflictRepair(params.memoryDir, token);
    if (state.status === "pushed") helpers.onMemoryChanged?.();
    return SYNCED_STATUSES.has(state.status)
      ? { ...NO_WORKER, success: true, report: "No memory conflict remains." }
      : failed(NO_WORKER, syncSummary(state));
  }
  const result = await execute(params.memoryDir, {
    primaryRoot: params.memoryDir,
    writableRoots: [params.memoryDir],
  });
  if (params.signal?.aborted) {
    await clearMemoryConflictRepair(params.memoryDir, token);
    return failed(result, "Memory repair cancelled");
  }
  await completeMemoryConflictRepair(params.memoryDir, token);
  return settle(result, true, helpers);
}
