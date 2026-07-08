// Aggregation stage: merge every batch reflection output into the agent's
// real memory filesystem, in ONE pass. The aggregator always runs (even for
// one batch) and is the ONLY stage that touches the real memfs — it works in
// a memory worktree cloned from it, so it sees existing memory plus the git
// history of past reflections, and its commit is merged back (with recompile)
// through the same finalize path as conversation reflections. When the input
// count is large, the aggregator itself decides whether to delegate subset
// review to its own subagents — the pipeline imposes no fan-out structure.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
import { finalizeReflectionMemoryWorktreeLaunch } from "@/cli/helpers/reflection-launcher";
import { debugWarn } from "@/utils/debug";
import { getDreamAggregateDir } from "./paths";
import { type AggregationInput, buildAggregationPrompt } from "./prompts";
import {
  type BatchReflectionResult,
  gitOutput,
  recordConversationTrajectory,
} from "./reflect";

export interface DreamAggregationOutcome {
  success: boolean;
  message: string;
  error?: string;
  subagentId?: string;
  /** True when there was nothing to merge and memory was left untouched. */
  skippedEmpty: boolean;
}

export interface RunDreamAggregationParams {
  agentId: string;
  conversationId: string;
  /** Persistent reflector agent the pass runs on (fresh conversation). */
  reflectorAgentId: string;
  runId: string;
  runRoot: string;
  reflections: BatchReflectionResult[];
  instruction?: string;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  log?: (line: string) => void;
}

function aggregationInputForBatch(
  result: BatchReflectionResult,
): AggregationInput {
  return {
    label: `batch-${result.batchIndex}`,
    // The batch directory (output/, report.json, trajectory.json, input/).
    dir: dirname(result.outputDir),
    timeRange: result.timeRange,
    sessionCount: result.sessionIds.length,
  };
}

/**
 * Preserve the aggregator's worktree state before finalize merges and removes
 * it: the full file tree (sans .git) into {aggregateDir}/output, plus the
 * commit log and patch relative to the base revision.
 */
async function snapshotAggregatorWorktree(
  worktreeDir: string,
  baseHead: string,
  aggregateDir: string,
): Promise<void> {
  try {
    const outputDir = join(aggregateDir, "output");
    await rm(outputDir, { recursive: true, force: true });
    await cp(worktreeDir, outputDir, {
      recursive: true,
      filter: (source) => basename(source) !== ".git",
    });
    const gitLog = await gitOutput(worktreeDir, [
      "log",
      "--format=%h  %s",
      "--reverse",
      `${baseHead}..HEAD`,
    ]).catch(() => "");
    const gitPatch = await gitOutput(worktreeDir, [
      "log",
      "-p",
      "--reverse",
      "--format=commit %h%n%s%n",
      `${baseHead}..HEAD`,
    ]).catch(() => "");
    await writeFile(join(aggregateDir, "git-log.txt"), `${gitLog}\n`, "utf-8");
    await writeFile(
      join(aggregateDir, "memfs.patch"),
      `${gitPatch}\n`,
      "utf-8",
    );
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to snapshot aggregator worktree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function runDreamAggregation(
  params: RunDreamAggregationParams,
): Promise<DreamAggregationOutcome> {
  const log = params.log ?? (() => {});

  // Batches that failed or produced nothing contribute nothing to merge.
  const withContent = params.reflections.filter(
    (r) => r.success && (r.commitCount > 0 || r.dirty),
  );
  if (withContent.length === 0) {
    return {
      success: true,
      message:
        "Reflections found no durable learnings to persist; memory left unchanged.",
      skippedEmpty: true,
    };
  }

  const aggregateDir = getDreamAggregateDir(params.runRoot);
  await mkdir(aggregateDir, { recursive: true });

  const inputs = withContent.map(aggregationInputForBatch);

  const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });

  try {
    const prompt = buildAggregationPrompt({
      inputs,
      instruction: params.instruction,
    });
    const baseScope = buildReflectionMemoryScope(worktree);
    const memoryScope = {
      ...baseScope,
      readonlyRoots: [...baseScope.readonlyRoots, params.runRoot],
    };

    const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");
    log(
      `[aggregate] integrating ${inputs.length} reflection output(s) into memory`,
    );

    return await new Promise<DreamAggregationOutcome>((resolve) => {
      spawnBackgroundSubagentTask({
        subagentType: "reflection",
        prompt,
        description: "Dream: aggregate reflections into memory",
        silentCompletion: true,
        existingAgentId: params.reflectorAgentId,
        memoryScope,
        parentScope: {
          agentId: params.agentId,
          conversationId: params.conversationId,
        },
        onComplete: async ({
          success,
          error,
          agentId: subagentAgentId,
          conversationId: aggConversationId,
          report,
          durationMs,
          stepCount,
        }) => {
          // The worktree is merged and removed by finalize below; preserve
          // what the aggregator produced first so the run stays inspectable.
          await snapshotAggregatorWorktree(
            worktree.worktreeDir,
            worktree.baseHead,
            aggregateDir,
          );
          await recordConversationTrajectory(
            aggConversationId,
            join(aggregateDir, "trajectory.json"),
          );
          await writeFile(
            join(aggregateDir, "report.json"),
            JSON.stringify(
              {
                subagentAgentId,
                conversationId: aggConversationId,
                success,
                error,
                durationMs,
                stepCount,
                inputs: inputs.map((r) => r.label),
                report: report ?? "",
              },
              null,
              2,
            ),
            "utf-8",
          ).catch(() => {});
          try {
            const { completionSuccess, completionMessage } =
              await finalizeReflectionMemoryWorktreeLaunch({
                worktree,
                subagentSuccess: success,
                subagentError: error,
                agentId: params.agentId,
                conversationId: params.conversationId,
                subagentAgentId,
                subagentType: "reflection",
                recompileByConversation: params.recompileByConversation,
                recompileQueuedByConversation:
                  params.recompileQueuedByConversation,
                logRecompileFailure: (message) => debugWarn("memory", message),
              });
            resolve({
              success: completionSuccess,
              message: completionMessage,
              error: completionSuccess ? undefined : (error ?? undefined),
              subagentId: subagentAgentId,
              skippedEmpty: false,
            });
          } catch (finalizeError) {
            resolve({
              success: false,
              message: `Aggregation finalize failed: ${
                finalizeError instanceof Error
                  ? finalizeError.message
                  : String(finalizeError)
              }`,
              error: String(finalizeError),
              skippedEmpty: false,
            });
          }
        },
      });
    });
  } catch (error) {
    await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: false,
    }).catch(() => {});
    throw error;
  }
}
