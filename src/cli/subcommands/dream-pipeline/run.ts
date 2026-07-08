// Dream pipeline orchestrator: select → normalize → batch → reflect → aggregate.
//
// Holds the per-agent reflection reservation for the whole run so automatic
// conversation reflections cannot merge into the memory filesystem while the
// aggregator is working. The ingest ledger is updated only for sessions whose
// batch succeeded AND whose aggregation committed, so failures leave sessions
// eligible for the next run.

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
import { dreamLedgerKey, recordDreamedSessions } from "./ledger";
import { getDreamRunRoot, newDreamRunId } from "./paths";
import { type BatchReflectionResult, runBatchReflections } from "./reflect";
import { getOrCreateDreamReflector } from "./reflector";
import { type DreamSourceSpec, selectDreamSessions } from "./select";

export interface DreamPipelineOptions {
  agentId: string;
  /** Conversation whose context is recompiled after the memory merge. */
  conversationId: string;
  specs: DreamSourceSpec[];
  instruction?: string;
  /** Extra instruction for the aggregation pass only (e.g. --to doc upkeep). */
  aggregationInstruction?: string;
  planOnly?: boolean;
  force?: boolean;
  batchTokenBudget: number;
  maxSessionsPerBatch: number;
  /** Cap on concurrent batch reflections; default: every batch at once. */
  concurrency?: number;
  recompileByConversation: Map<string, Promise<void>>;
  recompileQueuedByConversation: Set<string>;
  log?: (line: string) => void;
}

export type DreamPipelineResult =
  | { kind: "nothing_new"; skippedByLedger: number }
  | { kind: "already_active" }
  | {
      kind: "plan";
      sessions: DiscoveredSession[];
      batches: DreamBatch[];
      skippedByLedger: number;
    }
  | {
      kind: "completed";
      runId: string;
      runRoot: string;
      success: boolean;
      message: string;
      sessionCount: number;
      skippedByLedger: number;
      batches: BatchReflectionResult[];
      aggregation?: DreamAggregationOutcome;
      vizPath?: string;
    };

async function writeRunManifest(
  runRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(runRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

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

  const selection = await selectDreamSessions({
    agentId: options.agentId,
    specs: options.specs,
    force: options.force,
  });
  if (selection.sessions.length === 0) {
    return {
      kind: "nothing_new",
      skippedByLedger: selection.skippedByLedger.length,
    };
  }

  // Normalize the selected sessions up front and pack on the size of the
  // normalized content. Raw store files shrink non-uniformly under
  // normalization (harness noise dropped, tool results truncated), so packing
  // on raw sizes skews batches; measuring what the reflection agents will
  // actually read keeps batches near budget — and makes --plan match reality.
  const normalizedJsonByKey = new Map<string, string>();
  const measuredSessions: DiscoveredSession[] = [];
  for (const session of selection.sessions) {
    const source = getTrajectorySource(session.harness);
    const { records } = await source.normalize(session);
    const json = JSON.stringify(records, null, 1);
    normalizedJsonByKey.set(dreamLedgerKey(session), json);
    measuredSessions.push({ ...session, estTokens: estimateTokens(json) });
  }

  const batches = packDreamBatches(
    measuredSessions,
    options.batchTokenBudget,
    options.maxSessionsPerBatch,
  );
  if (options.planOnly) {
    return {
      kind: "plan",
      sessions: measuredSessions,
      batches,
      skippedByLedger: selection.skippedByLedger.length,
    };
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
      `Selected ${selection.sessions.length} session(s) in ${batches.length} batch(es)` +
        (selection.skippedByLedger.length > 0
          ? ` (${selection.skippedByLedger.length} already reflected)`
          : ""),
    );

    const baseManifest = {
      runId,
      createdAt: new Date().toISOString(),
      agentId: options.agentId,
      specs: options.specs,
      batchTokenBudget: options.batchTokenBudget,
      maxSessionsPerBatch: options.maxSessionsPerBatch,
      concurrency: options.concurrency ?? batches.length,
      reflectorAgentId,
      sessions: measuredSessions,
      batchPlan: batches.map((batch) => ({
        index: batch.index,
        sessionIds: batch.sessions.map((s) => s.sessionId),
        estTokens: batch.estTokens,
        startTime: batch.startTime,
        endTime: batch.endTime,
      })),
    };
    await writeRunManifest(runRoot, baseManifest);

    const batchResults = await runBatchReflections({
      agentId: options.agentId,
      conversationId: options.conversationId,
      reflectorAgentId,
      runId,
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
      await writeRunManifest(runRoot, {
        ...baseManifest,
        batches: batchResults,
        outcome: { success: false, message },
      });
      return {
        kind: "completed",
        runId,
        runRoot,
        success: false,
        message,
        sessionCount: selection.sessions.length,
        skippedByLedger: selection.skippedByLedger.length,
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
      reflectorAgentId,
      runId,
      runRoot,
      reflections: batchResults,
      instruction: combinedAggregationInstruction || undefined,
      recompileByConversation: options.recompileByConversation,
      recompileQueuedByConversation: options.recompileQueuedByConversation,
      log,
    });

    if (aggregation.success) {
      const reflectedSessions = batchResults
        .filter((r) => r.success)
        .flatMap((r) => batches[r.batchIndex]?.sessions ?? []);
      await recordDreamedSessions(options.agentId, reflectedSessions, runId);
    }

    await writeRunManifest(runRoot, {
      ...baseManifest,
      batches: batchResults,
      aggregation,
      outcome: {
        success: aggregation.success,
        failedBatchCount: failedBatches.length,
        message: aggregation.message,
      },
    });

    const suffix =
      failedBatches.length > 0
        ? ` (${failedBatches.length} batch(es) failed and will be retried next run)`
        : "";
    return {
      kind: "completed",
      runId,
      runRoot,
      success: aggregation.success,
      message: `${aggregation.message}${suffix}`,
      sessionCount: selection.sessions.length,
      skippedByLedger: selection.skippedByLedger.length,
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
 * batch reflection outputs. The previous aggregate artifacts are set aside as
 * aggregate-prev-<n>; the ingest ledger is not touched (the original run
 * already recorded its sessions).
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
  const manifestRaw = await readFile(
    join(options.runRoot, "manifest.json"),
    "utf-8",
  );
  const manifest = JSON.parse(manifestRaw) as {
    runId?: string;
    batches?: BatchReflectionResult[];
  };
  const runId = manifest.runId ?? basename(options.runRoot);
  const batchResults = (manifest.batches ?? []).filter(
    (batch) =>
      typeof batch?.outputDir === "string" && existsSync(batch.outputDir),
  );
  if (batchResults.length === 0) {
    throw new Error(
      `No recorded batch outputs found in ${options.runRoot}/manifest.json — run the full dream first`,
    );
  }

  if (!tryReserveReflectionLaunch(options.agentId)) {
    return { kind: "already_active" };
  }
  try {
    const reflectorAgentId = await getOrCreateDreamReflector({
      primaryAgentId: options.agentId,
      log,
    });

    // Preserve the previous aggregation attempt's artifacts.
    const aggregateDir = join(options.runRoot, "aggregate");
    if (existsSync(aggregateDir)) {
      let n = 1;
      while (existsSync(join(options.runRoot, `aggregate-prev-${n}`))) n++;
      await rename(aggregateDir, join(options.runRoot, `aggregate-prev-${n}`));
    }

    log(
      `[aggregate] re-running aggregation for ${runId} over ${batchResults.length} recorded batch(es)`,
    );
    const aggregation = await runDreamAggregation({
      agentId: options.agentId,
      conversationId: options.conversationId,
      reflectorAgentId,
      runId,
      runRoot: options.runRoot,
      reflections: batchResults,
      instruction: options.instruction,
      recompileByConversation: options.recompileByConversation,
      recompileQueuedByConversation: options.recompileQueuedByConversation,
      log,
    });

    await writeRunManifest(options.runRoot, {
      ...(JSON.parse(manifestRaw) as Record<string, unknown>),
      aggregation,
      aggregationRerun: true,
      outcome: { success: aggregation.success, message: aggregation.message },
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
