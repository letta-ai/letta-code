// Dream pipeline orchestrator: select → normalize → batch → reflect → aggregate.
//
// Holds the per-agent reflection reservation for the whole run so automatic
// conversation reflections cannot merge into the memory filesystem while the
// aggregator is working. Every run re-processes whatever its --from specs
// select; use cursors (e.g. claude:<session>) to narrow repeat runs.

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTrajectorySource } from "@/agent/trajectories/registry";
import {
  type DiscoveredSession,
  estimateTokens,
} from "@/agent/trajectories/types";
import {
  releaseReflectionLaunch,
  tryReserveReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import { type DreamAggregationOutcome, runDreamAggregation } from "./aggregate";
import { type DreamBatch, packDreamBatches } from "./batching";
import { getDreamRunRoot, newDreamRunId } from "./paths";
import { type BatchReflectionResult, runBatchReflections } from "./reflect";
import { getOrCreateDreamReflector } from "./reflector";
import {
  type DreamSourceSpec,
  selectDreamSessions,
  sessionKey,
} from "./select";

export interface DreamPipelineOptions {
  agentId: string;
  /** Conversation whose context is recompiled after the memory merge. */
  conversationId: string;
  specs: DreamSourceSpec[];
  instruction?: string;
  /** Extra instruction for the aggregation pass only (e.g. --to doc upkeep). */
  aggregationInstruction?: string;
  planOnly?: boolean;
  batchTokenBudget: number;
  maxSessionsPerBatch: number;
  /** Cap on concurrent batch reflections; default: every batch at once. */
  concurrency?: number;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  log?: (line: string) => void;
}

export type DreamPipelineResult =
  | { kind: "nothing_new" }
  | { kind: "already_active" }
  | {
      kind: "plan";
      sessions: DiscoveredSession[];
      batches: DreamBatch[];
    }
  | {
      kind: "completed";
      runId: string;
      runRoot: string;
      success: boolean;
      message: string;
      sessionCount: number;
      batches: BatchReflectionResult[];
      aggregation?: DreamAggregationOutcome;
      vizPath?: string;
    };

/** Best-effort viz.html render into the run root. */
async function writeRunViz(runRoot: string): Promise<string | undefined> {
  try {
    const { generateDreamViz } = await import("./viz");
    const vizPath = join(runRoot, "viz.html");
    await writeFile(vizPath, generateDreamViz(runRoot).html, "utf-8");
    return vizPath;
  } catch {
    return undefined;
  }
}

export async function runDreamPipeline(
  options: DreamPipelineOptions,
): Promise<DreamPipelineResult> {
  const log = options.log ?? (() => {});

  const sessions = await selectDreamSessions({
    agentId: options.agentId,
    specs: options.specs,
  });
  if (sessions.length === 0) {
    return { kind: "nothing_new" };
  }

  // Normalize the selected sessions up front and pack on the size of the
  // normalized content. Raw store files shrink non-uniformly under
  // normalization (harness noise dropped, tool results truncated), so packing
  // on raw sizes skews batches; measuring what the reflection agents will
  // actually read keeps batches near budget — and makes --plan match reality.
  const normalizedJsonByKey = new Map<string, string>();
  const measuredSessions: DiscoveredSession[] = [];
  for (const session of sessions) {
    const source = getTrajectorySource(session.harness);
    const { records } = await source.normalize(session);
    const json = JSON.stringify(records, null, 1);
    normalizedJsonByKey.set(sessionKey(session), json);
    measuredSessions.push({ ...session, estTokens: estimateTokens(json) });
  }

  const batches = packDreamBatches(
    measuredSessions,
    options.batchTokenBudget,
    options.maxSessionsPerBatch,
  );
  if (options.planOnly) {
    return { kind: "plan", sessions: measuredSessions, batches };
  }

  if (!tryReserveReflectionLaunch(options.agentId)) {
    return { kind: "already_active" };
  }

  const runId = newDreamRunId();
  const runRoot = getDreamRunRoot(options.agentId, runId);
  try {
    await mkdir(runRoot, { recursive: true });
    const reflectorAgentId = await getOrCreateDreamReflector({
      primaryAgentId: options.agentId,
      log,
    });
    log(
      `Selected ${sessions.length} session(s) in ${batches.length} batch(es)`,
    );

    const batchResults = await runBatchReflections({
      agentId: options.agentId,
      conversationId: options.conversationId,
      reflectorAgentId,
      runRoot,
      batches,
      normalizedJsonByKey,
      concurrency: options.concurrency ?? batches.length,
      instruction: options.instruction,
      log,
    });

    const failedBatches = batchResults.filter((r) => !r.success);
    if (failedBatches.length === batchResults.length) {
      const message = `All ${batchResults.length} reflection batch(es) failed; memory left unchanged.`;
      return {
        kind: "completed",
        runId,
        runRoot,
        success: false,
        message,
        sessionCount: sessions.length,
        batches: batchResults,
        vizPath: await writeRunViz(runRoot),
      };
    }

    const combinedAggregationInstruction = [
      options.instruction?.trim(),
      options.aggregationInstruction?.trim(),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");

    const aggregation = await runDreamAggregation({
      agentId: options.agentId,
      conversationId: options.conversationId,
      runRoot,
      reflections: batchResults,
      instruction: combinedAggregationInstruction || undefined,
      recompileByConversation: options.recompileByConversation,
      recompileQueuedByConversation: options.recompileQueuedByConversation,
      log,
    });

    const suffix =
      failedBatches.length > 0
        ? ` (${failedBatches.length} batch(es) failed)`
        : "";
    return {
      kind: "completed",
      runId,
      runRoot,
      success: aggregation.success,
      message: `${aggregation.message}${suffix}`,
      sessionCount: sessions.length,
      batches: batchResults,
      aggregation,
      vizPath: await writeRunViz(runRoot),
    };
  } finally {
    releaseReflectionLaunch(options.agentId);
  }
}

export interface RerunAggregationResult {
  runRoot: string;
  success: boolean;
  message: string;
  vizPath?: string;
}

/**
 * Re-run ONLY the aggregation pass of a recorded dream run, using its existing
 * batch reflection outputs, rebuilt from each batch directory's report.json.
 */
export async function rerunDreamAggregationForRun(options: {
  agentId: string;
  conversationId: string;
  runRoot: string;
  instruction?: string;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  log?: (line: string) => void;
}): Promise<RerunAggregationResult | { kind: "already_active" }> {
  const log = options.log ?? (() => {});
  const batchesDir = join(options.runRoot, "batches");
  const batchResults: BatchReflectionResult[] = [];
  if (existsSync(batchesDir)) {
    for (const name of readdirSync(batchesDir).sort(
      (a, b) => Number(a) - Number(b),
    )) {
      try {
        const report = JSON.parse(
          await readFile(join(batchesDir, name, "report.json"), "utf-8"),
        ) as BatchReflectionResult;
        if (existsSync(report.outputDir)) {
          batchResults.push(report);
        }
      } catch {
        // A batch without a readable report contributes nothing.
      }
    }
  }
  if (batchResults.length === 0) {
    throw new Error(
      `No recorded batch outputs found under ${batchesDir} — run the full dream first`,
    );
  }

  if (!tryReserveReflectionLaunch(options.agentId)) {
    return { kind: "already_active" };
  }
  try {
    log(
      `[aggregate] re-running aggregation over ${batchResults.length} recorded batch(es)`,
    );
    const aggregation = await runDreamAggregation({
      agentId: options.agentId,
      conversationId: options.conversationId,
      runRoot: options.runRoot,
      reflections: batchResults,
      instruction: options.instruction,
      recompileByConversation: options.recompileByConversation,
      recompileQueuedByConversation: options.recompileQueuedByConversation,
      log,
    });

    return {
      runRoot: options.runRoot,
      success: aggregation.success,
      message: aggregation.message,
      vizPath: await writeRunViz(options.runRoot),
    };
  } finally {
    releaseReflectionLaunch(options.agentId);
  }
}
