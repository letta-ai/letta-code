import { join } from "node:path";
import { detectMemoryFormat } from "@/agent/memory-format";
import { syncPendingMemoryCommitsAfterTurn } from "@/agent/memory-git";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  type ReflectionMemoryWorktree,
  reflectionMemoryParentHasChanges,
} from "@/agent/memory-worktree";
import { getBackend } from "@/backend";
import {
  type SpawnBackgroundSubagentTaskArgs,
  spawnBackgroundSubagentTask,
} from "@/tools/impl/task";
import { getTranscriptRoot } from "@/utils/transcript-paths";
import {
  handleMemorySubagentCompletion,
  type MemorySubagentCompletionDeps,
} from "./memory-subagent-completion";

export interface DoctorCommandOptions extends MemorySubagentCompletionDeps {
  agentId: string;
  conversationId: string;
  memoryDir?: string;
  symptom?: string;
  actingUserId?: string;
}

interface DoctorCommandDeps {
  spawn?: typeof spawnBackgroundSubagentTask;
  isLocal?: () => boolean;
  syncMemory?: typeof syncPendingMemoryCommitsAfterTurn;
}

export async function launchDoctor(
  input: DoctorCommandOptions,
  deps: DoctorCommandDeps = {},
): Promise<string> {
  const options = { ...input };
  const { agentId, conversationId, memoryDir } = options;
  if (!agentId || !conversationId) {
    throw new Error("Doctor requires a target agent and conversation.");
  }
  const parentDirty = memoryDir
    ? await reflectionMemoryParentHasChanges(memoryDir)
    : false;
  // Even diagnosis-only runs get an isolated scope when memory exists. The
  // investigator can read the dirty parent without writing to it.
  const worktree = memoryDir
    ? await createReflectionMemoryWorktree({ parentMemoryDir: memoryDir })
    : undefined;
  try {
    const local = (
      deps.isLocal ?? (() => getBackend().capabilities.localMemfs)
    )();
    const prompt = [
      "Investigate the target agent using the context-doctor skill.",
      `Target agent ID: ${agentId}`,
      `Target conversation ID: ${conversationId}`,
      `Backend: ${local ? "local" : "api"}`,
      `Memory format: ${memoryDir ? detectMemoryFormat(memoryDir, local) : "none"}`,
      `Target client transcript directory: ${join(getTranscriptRoot(), agentId, conversationId)}`,
      memoryDir
        ? `Original memory directory (read only): ${memoryDir}`
        : "The target has no memory filesystem.",
      worktree
        ? `Memory worktree: ${worktree.worktreeDir}\nOriginal memory base commit: ${worktree.baseHead}`
        : "",
      !worktree || parentDirty
        ? "Diagnosis only: do not edit or commit memory. The target has no memory filesystem or has uncommitted memory changes. Report recommended repairs."
        : "Commit supported repairs in the supplied memory worktree; do not merge or push. The harness handles integration, sync, and recompilation.",
      "Use explicit --agent and --conversation arguments when reading target history. Inspect the selected conversation first; search other target conversations only when relevant. Client transcripts may omit failed or interrupted turns.",
      `User symptom: ${options.symptom?.trim() || "Review recent behavior for recurring corrections, failures, and context problems. Include a successful example for comparison."}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    let completion = "Doctor report ready.";
    const args: SpawnBackgroundSubagentTaskArgs = {
      subagentType: "doctor",
      description: "Investigating agent behavior",
      prompt,
      parentScope: { agentId, conversationId },
      actingUserId: options.actingUserId,
      ...(worktree
        ? { memoryScope: buildReflectionMemoryScope(worktree) }
        : {}),
      completionSummary: () => completion,
      onComplete: async (result) => {
        completion = result.success
          ? `${doctorReportHeadline(result.report)} No memory changes applied.`
          : `Doctor failed: ${result.error ?? "Unknown error"}`;
        if (!worktree) return;
        try {
          completion = await finishDoctor(
            worktree,
            result.success && !parentDirty,
            completion,
            options,
            deps,
          );
        } catch (error) {
          completion = `Doctor integration failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    };
    const task = (deps.spawn ?? spawnBackgroundSubagentTask)(args);
    return `Doctor is investigating in the background. Task: ${task.taskId}. Report: ${task.outputFile}`;
  } catch (error) {
    if (worktree)
      await finalizeReflectionMemoryWorktree(worktree, { shouldMerge: false });
    throw error;
  }
}

function doctorReportHeadline(report: string | undefined): string {
  const firstLine = report?.trim().split(/\r?\n/, 1)[0]?.trim();
  // The skill supplies the diagnosis, including whether evidence was blocked.
  // Process success only means it returned a report; never infer a diagnosis
  // from that flag or classify arbitrary report prose in the harness.
  if (
    firstLine &&
    /^Doctor (diagnosis|inconclusive|blocked):\s+\S/.test(firstLine)
  ) {
    return firstLine.slice(0, 300);
  }
  return "Doctor report ready.";
}

async function finishDoctor(
  worktree: ReflectionMemoryWorktree,
  shouldMerge: boolean,
  completion: string,
  options: DoctorCommandOptions,
  deps: DoctorCommandDeps,
): Promise<string> {
  const integration = await finalizeReflectionMemoryWorktree(worktree, {
    shouldMerge,
  });
  if (!shouldMerge || integration.status === "no_changes") return completion;
  if (integration.status !== "merged") {
    return `Doctor did not apply memory changes (${integration.status}). ${integration.error ?? "The memory worktree was cleaned up; rerun the investigation to retry."}`;
  }
  const sync = await (deps.syncMemory ?? syncPendingMemoryCommitsAfterTurn)(
    options.agentId,
    {
      memoryDir: worktree.parentMemoryDir,
    },
  );
  if (
    sync.status !== "clean" &&
    sync.status !== "pushed" &&
    !(sync.status === "skipped" && sync.localOnly)
  ) {
    return `Doctor committed memory changes locally, but could not sync them (${sync.status}): ${sync.summary} System prompt was not recompiled.`;
  }
  return handleMemorySubagentCompletion(
    {
      agentId: options.agentId,
      conversationId: options.conversationId,
      subagentType: "doctor",
      success: true,
      successMessageOverride: "Doctor applied memory changes.",
    },
    options,
  );
}
