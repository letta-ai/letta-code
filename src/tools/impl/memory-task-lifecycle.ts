import {
  claimMemoryConflictRepair,
  type ReleaseMemoryConflictRepair,
} from "@/agent/memory-conflict-repair";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import {
  emitStreamEvent,
  getSnapshot as getSubagentSnapshot,
  subscribeToSubagentLifecycle,
} from "@/agent/subagent-state";
import type { SubagentMemoryScope, SubagentResult } from "@/agent/subagents";
import { withMemoryHandoff } from "@/agent/subagents/memory-handoff";
import { runMemoryWorker } from "@/agent/subagents/memory-worker";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import { debugWarn } from "@/utils/debug";
import { sleep } from "@/utils/sleep";
import { appendToOutputFile, backgroundTasks } from "./process_manager";

export interface RunBackgroundMemoryTaskParams {
  agentId: string;
  conversationId: string;
  memoryDir: string;
  assignment: string;
  repairOnly?: boolean;
  /** Forgets this repair's attempt marker if it is cancelled before running. */
  releaseRepairAttempt?: () => Promise<void>;
  signal: AbortSignal;
  subagentId: string;
  outputFile: string;
  /** Transcript header for a worker identity, in the task's usual format. */
  formatHeader: (
    identity: Pick<SubagentResult, "agentId" | "conversationId">,
  ) => string;
  /**
   * Spawn the worker with the handoff prompt, optional transcript snapshot,
   * and the memory scope of the private worktree it must edit.
   */
  execute: (
    assignment: string,
    transcriptPath: string | undefined,
    memoryScope: SubagentMemoryScope,
  ) => Promise<SubagentResult>;
  /** Harness conflict repair, launched when the worker's sync leaves a conflict. */
  repair: (result: MemoryPostTurnSyncResult) => void | Promise<unknown>;
  getSnapshot?: typeof getSubagentSnapshot;
}

/**
 * Run a fresh memory worker under its checkout lock. The worker's identity and
 * report are written to the task log as soon as they are known so the primary
 * can inspect the task even when remote sync is slow or fails afterwards.
 */
export function runBackgroundMemoryTask(
  params: RunBackgroundMemoryTaskParams,
): {
  execution: Promise<SubagentResult>;
  unsubscribe: () => void;
} {
  const getSnapshot = params.getSnapshot ?? getSubagentSnapshot;
  let loggedAddress = "";
  const unsubscribe = subscribeToSubagentLifecycle(() => {
    const worker = getSnapshot().agents.find(
      (entry) => entry.id === params.subagentId,
    );
    if (!worker?.agentId || !worker.conversationId) return;
    const address = `${worker.agentId}:${worker.conversationId}`;
    if (address === loggedAddress) return;
    loggedAddress = address;
    appendToOutputFile(
      params.outputFile,
      `${params.formatHeader({ agentId: worker.agentId, conversationId: worker.conversationId })}\n`,
    );
  });
  const scope = {
    agentId: params.agentId,
    conversationId: params.conversationId,
    memoryDir: params.memoryDir,
    repairOnly: params.repairOnly,
  };
  const execution = runMemoryWorker(
    { ...scope, signal: params.signal },
    (workerDir, memoryScope) =>
      withMemoryHandoff(
        {
          ...scope,
          memoryDir: workerDir,
          assignment: params.assignment,
          signal: params.signal,
        },
        async (handoff) => {
          const result = await params.execute(
            handoff.prompt,
            handoff.transcriptPath,
            memoryScope,
          );
          // Preserve the worker identity/report even if remote sync is slow or fails.
          appendToOutputFile(
            params.outputFile,
            `${params.formatHeader(result)}\n\n${result.report}\n[Memory worker finished; syncing commits]\n`,
          );
          return result;
        },
      ),
    {
      onMemoryChanged: () => {
        emitStreamEvent(params.subagentId, {
          type: "memory_updated",
          affected_paths: ["*"],
          timestamp: Date.now(),
        });
      },
      repair: params.repair,
    },
  ).finally(() =>
    // A repair cancelled at exit has not been tried; let the next session retry it.
    params.repairOnly && params.signal.aborted
      ? params.releaseRepairAttempt?.()
      : undefined,
  );
  return { execution, unsubscribe };
}

/** Launch a repair-only worker; false when already attempted or the launch failed. */
export async function startMemoryConflictRepair(
  params: {
    agentId: string;
    conversationId?: string | null;
    result: MemoryPostTurnSyncResult;
    actingUserId?: string;
  },
  spawn: (args: SpawnBackgroundSubagentTaskArgs) => unknown,
  claimRepair = claimMemoryConflictRepair,
): Promise<boolean> {
  let release: ReleaseMemoryConflictRepair | null = null;
  try {
    release = await claimRepair(params.result.memoryDir);
    if (!release) return false;
    spawn({
      subagentType: "memory",
      description: "Repair memory Git conflict",
      prompt: `Repair only the existing Git conflict in your memory repository. Do not perform unrelated edits or reorganization. If the conflict is already resolved, stop.\n\nMemory directory: ${params.result.memoryDir}\nReported status: ${params.result.summary}`,
      parentScope: {
        agentId: params.agentId,
        conversationId: params.conversationId ?? "default",
      },
      memoryScope: {
        primaryRoot: params.result.memoryDir,
        writableRoots: [params.result.memoryDir],
      },
      memoryRepairOnly: true,
      releaseRepairAttempt: release,
      actingUserId: params.actingUserId,
    });
    return true;
  } catch (error) {
    // Capacity or checkout errors must not become unhandled rejections, and
    // an attempt that never launched must not block the next turn's retry.
    debugWarn("memory-repair", `Could not launch repair: ${String(error)}`);
    await release?.({ leaseHeld: true }).catch(() => undefined);
    return false;
  }
}

/** Await child teardown before the process owning its checkout lock exits. */
export async function finishBackgroundMemoryTasks(
  agentId?: string,
  conversationId?: string,
  options: { cancel?: boolean } = {},
): Promise<void> {
  const finished = new Set<Promise<void>>();
  for (;;) {
    const pending = [...backgroundTasks.values()]
      .filter(
        (task) =>
          task.subagentType === "memory" &&
          (!agentId || task.runtimeScope?.agentId === agentId) &&
          (!conversationId ||
            task.runtimeScope?.conversationId === conversationId),
      )
      .map((task) => {
        if (options.cancel) task.abortController?.abort();
        return task.completion;
      })
      .filter((completion): completion is Promise<void> =>
        Boolean(completion && !finished.has(completion)),
      );
    if (pending.length === 0) return;
    // One task's failure must not skip the teardown of the others.
    await Promise.allSettled(pending);
    for (const completion of pending) finished.add(completion);
  }
}

/** Most workers finish within seconds; give them that before dropping their work. */
const INTERACTIVE_EXIT_GRACE_MS = 10_000;

/**
 * Interactive exits wait briefly for running memory work, then cancel what is
 * left so the child, its snapshot and its lock are torn down before the
 * process goes. Work still in flight after the grace period is dropped.
 */
export async function cancelBackgroundMemoryTasks(
  graceMs = INTERACTIVE_EXIT_GRACE_MS,
): Promise<void> {
  let expired = false;
  await Promise.race([
    finishBackgroundMemoryTasks(),
    sleep(graceMs).then(() => {
      expired = true;
    }),
  ]);
  if (expired) {
    await finishBackgroundMemoryTasks(undefined, undefined, { cancel: true });
  }
}

/** Controlled process exits must account for tasks from previously active conversations too. */
export async function shutdownBackgroundMemoryTasks(
  exitCode: number,
): Promise<void> {
  await finishBackgroundMemoryTasks(undefined, undefined, {
    cancel: exitCode !== 0,
  });
}
