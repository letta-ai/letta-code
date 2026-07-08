// Aggregation stage: merge every batch reflection output into the agent's
// real memory filesystem, in ONE pass. The aggregator always runs (even for
// one batch) and is the ONLY stage that touches the real memfs — it works in
// a memory worktree cloned from it, so it sees existing memory plus the git
// history of past reflections, and its commit is merged back (with recompile)
// through the same finalize path as conversation reflections. When the input
// count is large, the aggregator itself decides whether to delegate subset
// review to its own subagents — the pipeline imposes no fan-out structure.

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  buildReflectionMemoryScope,
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
} from "@/agent/memory-worktree";
import { finalizeReflectionMemoryWorktreeLaunch } from "@/cli/helpers/reflection-launcher";
import { debugWarn } from "@/utils/debug";
import { getDreamAggregateDir } from "./paths";
import { buildAggregationPrompt } from "./prompts";
import {
  type BatchReflectionResult,
  gitOutput,
  recordConversationTrajectory,
} from "./reflect";
import { getOrCreateDreamAggregator } from "./reflector";

export interface DreamAggregationOutcome {
  success: boolean;
  message: string;
  error?: string;
  subagentId?: string;
}

export interface RunDreamAggregationParams {
  agentId: string;
  conversationId: string;
  runRoot: string;
  reflections: BatchReflectionResult[];
  instruction?: string;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  log?: (line: string) => void;
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
    };
  }

  const aggregateDir = getDreamAggregateDir(params.runRoot);
  await mkdir(aggregateDir, { recursive: true });

  // The aggregator is its own persistent hidden agent (default system prompt
  // + aggregator persona), separate from the reflector.
  const aggregatorAgentId = await getOrCreateDreamAggregator({
    primaryAgentId: params.agentId,
    log,
  });

  const memoryDir = getScopedMemoryFilesystemRoot(params.agentId);
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });

  try {
    const prompt = buildAggregationPrompt({
      batchesDir: join(params.runRoot, "batches"),
      batchCount: params.reflections.length,
      instruction: params.instruction,
    });
    const baseScope = buildReflectionMemoryScope(worktree);
    const memoryScope = {
      ...baseScope,
      readonlyRoots: [...baseScope.readonlyRoots, params.runRoot],
    };

    const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");
    log(
      `[aggregate] integrating ${withContent.length} reflection output(s) into memory`,
    );

    return await new Promise<DreamAggregationOutcome>((resolve) => {
      spawnBackgroundSubagentTask({
        subagentType: "general-purpose",
        prompt,
        description: "Dream: aggregate reflections into memory",
        silentCompletion: true,
        existingAgentId: aggregatorAgentId,
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
                inputs: withContent.map((r) => `batch-${r.batchIndex}`),
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
