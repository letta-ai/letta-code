import {
  claimMemoryConflictRepair,
  clearMemoryConflictRepair,
  type MemoryConflictRepairClaim,
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
  repairToken: string;
  signal: AbortSignal;
  subagentId: string;
  outputFile: string;
  formatHeader: (
    identity: Pick<SubagentResult, "agentId" | "conversationId">,
  ) => string;
  execute: (
    assignment: string,
    transcriptPath: string | undefined,
    memoryScope: SubagentMemoryScope,
  ) => Promise<SubagentResult>;
  repair: (result: MemoryPostTurnSyncResult) => void | Promise<unknown>;
  getSnapshot?: typeof getSubagentSnapshot;
}

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
  };
  const execution = runMemoryWorker(
    { ...scope, repairToken: params.repairToken, signal: params.signal },
    (workerDir, memoryScope) =>
      withMemoryHandoff(
        {
          ...scope,
          memoryDir: workerDir,
          assignment: params.assignment,
          repairOnly: true,
          signal: params.signal,
        },
        async (handoff) => {
          const result = await params.execute(
            handoff.prompt,
            handoff.transcriptPath,
            memoryScope,
          );
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
  );
  return { execution, unsubscribe };
}

export async function ensureMemoryRepair(
  params: {
    agentId: string;
    conversationId?: string | null;
    result: MemoryPostTurnSyncResult;
    actingUserId?: string | null;
  },
  spawn: (args: SpawnBackgroundSubagentTaskArgs) => unknown,
  claimRepair = claimMemoryConflictRepair,
): Promise<boolean> {
  let claim: MemoryConflictRepairClaim | undefined;
  try {
    const kind = params.result.status === "invalid" ? "invalid" : "conflict";
    claim = await claimRepair(params.result.memoryDir, kind);
    if (claim.status !== "claimed") return claim.status === "in_progress";
    const invalid = params.result.status === "invalid";
    spawn({
      subagentType: "memory",
      description: invalid
        ? "Repair invalid committed memory"
        : "Repair memory Git conflict",
      prompt: invalid
        ? `The committed memory tree fails the repository's validation, usually because concurrent memory updates were combined. Make one new commit that brings the current memory within the limits while preserving its information: move detail out of oversized files and behind indexes instead of deleting it. Do not change or disable the limits, rewrite history, or perform unrelated edits. If the committed memory already passes validation, stop.\n\nMemory directory: ${params.result.memoryDir}\nReported status: ${params.result.summary}`
        : `Repair only the existing Git conflict in your memory repository. Do not perform unrelated edits or reorganization. If the conflict is already resolved, stop.\n\nMemory directory: ${params.result.memoryDir}\nReported status: ${params.result.summary}`,
      parentScope: {
        agentId: params.agentId,
        conversationId: params.conversationId ?? "default",
      },
      memoryScope: {
        primaryRoot: params.result.memoryDir,
        writableRoots: [params.result.memoryDir],
      },
      memoryRepairToken: claim.token,
      actingUserId: params.actingUserId,
    });
    return true;
  } catch (error) {
    debugWarn("memory", `Could not launch repair: ${String(error)}`);
    if (claim?.status === "claimed") {
      await clearMemoryConflictRepair(params.result.memoryDir, claim.token);
    }
    return false;
  }
}

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
    await Promise.allSettled(pending);
    for (const completion of pending) finished.add(completion);
  }
}

const INTERACTIVE_EXIT_GRACE_MS = 10_000;

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

export async function shutdownBackgroundMemoryTasks(
  exitCode: number,
): Promise<void> {
  await finishBackgroundMemoryTasks(undefined, undefined, {
    cancel: exitCode !== 0,
  });
}
