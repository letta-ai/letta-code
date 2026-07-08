// Batch reflection stage: one reflection subagent per batch, each writing to a
// fresh seeded memory tree. Unlike the conversation-reflection path, no memory
// worktree is involved — the trees are standalone git repos under the run
// directory, and nothing here touches the agent's real memory filesystem
// (integration is the aggregation stage's job).
//
// Each batch directory is self-contained:
//   input/            the batch's normalized session transcripts (listed
//                     inline in the reflection agent's prompt)
//   output/           the memory filesystem the reflection agent produced
//   trajectory.json   the agent's own run, normalized-v1 (same format as
//                     input/), fetched from its conversation on the reflector
//   report.json       structured outcome + the agent's final report

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { normalizeLettaMessages } from "@/agent/trajectories/letta-messages";
import { debugWarn } from "@/utils/debug";
import type { DreamBatch } from "./batching";
import { getDreamBatchDir, normalizedSessionFileName } from "./paths";
import { buildBatchReflectionPrompt } from "./prompts";
import { seedFreshMemoryTree } from "./seed";

const execFileAsync = promisify(execFile);

export async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

/** Commits beyond the seed commit, and whether the tree has uncommitted edits. */
export async function inspectMemoryTree(
  memoryDir: string,
): Promise<{ commitCount: number; dirty: boolean }> {
  let commitCount = 0;
  let dirty = false;
  try {
    const total = Number.parseInt(
      await gitOutput(memoryDir, ["rev-list", "--count", "HEAD"]),
      10,
    );
    commitCount = Number.isFinite(total) ? Math.max(0, total - 1) : 0;
    dirty = (await gitOutput(memoryDir, ["status", "--porcelain"])) !== "";
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to inspect batch memory tree at ${memoryDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return { commitCount, dirty };
}

/** Write a normalized-v1 transcript file (same encoding everywhere). */
export async function writeNormalizedRecords(
  path: string,
  records: unknown[],
): Promise<void> {
  await writeFile(path, JSON.stringify(records, null, 1), "utf-8");
}

const TRAJECTORY_PAGE_SIZE = 100;
const TRAJECTORY_MAX_PAGES = 50;

/**
 * Record a completed pass's trajectory by listing its conversation's messages
 * from the backend (they are complete and durably stored — reflection passes
 * run as fresh conversations on the reflector agent) and normalizing them into
 * a v1 transcript file. Returns the written path, or null when the
 * conversation is unknown or held no conversational content.
 */
export async function recordConversationTrajectory(
  conversationId: string | undefined,
  normalizedPath: string,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const { getBackend } = await import("@/backend");
    const backend = getBackend();
    const messages: unknown[] = [];
    let after: string | undefined;
    for (let page = 0; page < TRAJECTORY_MAX_PAGES; page++) {
      const result = await backend.listConversationMessages(conversationId, {
        limit: TRAJECTORY_PAGE_SIZE,
        order: "asc",
        include_return_message_types: [
          "user_message",
          "reasoning_message",
          "assistant_message",
          "approval_request_message",
          "tool_call_message",
          "tool_return_message",
        ],
        ...(after ? { after } : {}),
      });
      const items = pageItems(result);
      messages.push(...items);
      if (items.length < TRAJECTORY_PAGE_SIZE) break;
      const lastId = (items[items.length - 1] as { id?: string }).id;
      if (!lastId) break;
      after = lastId;
    }
    const records = normalizeLettaMessages(messages);
    if (!records) return null;
    await writeNormalizedRecords(normalizedPath, records);
    return normalizedPath;
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to record trajectory for conversation ${conversationId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as { getPaginatedItems?: () => T[]; items?: T[] };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) {
      return maybePage.items;
    }
  }
  return [];
}

export interface BatchReflectionResult {
  batchIndex: number;
  subagentId: string;
  /** Conversation on the reflector agent this batch ran as. */
  conversationId?: string;
  sessionIds: string[];
  timeRange: { start: string; end: string };
  outputDir: string;
  reportPath: string;
  /** The agent's run as a normalized-v1 transcript (null if nothing recorded). */
  trajectoryPath: string | null;
  success: boolean;
  error?: string;
  /** Commits the agent made beyond the seed commit. */
  commitCount: number;
  /** Uncommitted edits left behind (agent broke protocol; contents still on disk). */
  dirty: boolean;
  durationMs?: number;
  stepCount?: number;
}

export interface RunBatchReflectionsParams {
  agentId: string;
  conversationId: string;
  /** Persistent reflector agent every batch runs on (fresh conversation each). */
  reflectorAgentId: string;
  runRoot: string;
  batches: DreamBatch[];
  /** dreamLedgerKey(session) → normalized-v1 JSON (already serialized). */
  normalizedJsonByKey: Map<string, string>;
  concurrency: number;
  instruction?: string;
  log?: (line: string) => void;
}

async function runOneBatch(
  params: RunBatchReflectionsParams,
  batch: DreamBatch,
): Promise<BatchReflectionResult> {
  const log = params.log ?? (() => {});
  const batchDir = getDreamBatchDir(params.runRoot, batch.index);
  const inputDir = join(batchDir, "input");
  const outputDir = join(batchDir, "output");
  const reportPath = join(batchDir, "report.json");
  const trajectoryFilePath = join(batchDir, "trajectory.json");
  await mkdir(inputDir, { recursive: true });
  await seedFreshMemoryTree(outputDir, params.agentId);

  // Stage this batch's normalized sessions into its own input/ directory so
  // the batch is self-contained and the aggregator can consult the original
  // data. Normalization already happened during packing (run.ts).
  const sessionFileNames: string[] = [];
  for (const session of batch.sessions) {
    const key = `${session.harness}:${session.sessionId}`;
    const json = params.normalizedJsonByKey.get(key);
    if (!json) {
      throw new Error(`No normalized transcript staged for session ${key}`);
    }
    const fileName = normalizedSessionFileName(
      session.harness,
      session.sessionId,
    );
    await writeFile(join(inputDir, fileName), json, "utf-8");
    sessionFileNames.push(fileName);
  }

  const prompt = buildBatchReflectionPrompt({
    batchIndex: batch.index,
    inputDir,
    sessionFileNames,
    timeRange: { start: batch.startTime, end: batch.endTime },
    instruction: params.instruction,
  });

  const { spawnBackgroundSubagentTask } = await import("@/tools/impl/task");

  log(
    `[reflect:batch-${batch.index}] ${batch.sessions.length} session(s), ` +
      `~${batch.estTokens} tokens, ${batch.startTime} → ${batch.endTime}`,
  );

  const completion = await new Promise<{
    success: boolean;
    error?: string;
    conversationId?: string;
    stepCount?: number;
    durationMs?: number;
    report?: string;
    subagentId: string;
  }>((resolve) => {
    const { subagentId } = spawnBackgroundSubagentTask({
      subagentType: "reflection",
      prompt,
      description: `Dream: reflect on batch ${batch.index}`,
      silentCompletion: true,
      existingAgentId: params.reflectorAgentId,
      memoryScope: {
        primaryRoot: outputDir,
        writableRoots: [outputDir],
        readonlyRoots: [params.runRoot],
      },
      parentScope: {
        agentId: params.agentId,
        conversationId: params.conversationId,
      },
      onComplete: (result) => {
        resolve({ ...result, subagentId });
      },
    });
  });

  const trajectoryPath = await recordConversationTrajectory(
    completion.conversationId,
    trajectoryFilePath,
  );
  const { commitCount, dirty } = await inspectMemoryTree(outputDir);
  const result: BatchReflectionResult = {
    batchIndex: batch.index,
    subagentId: completion.subagentId,
    conversationId: completion.conversationId,
    sessionIds: batch.sessions.map((s) => s.sessionId),
    timeRange: { start: batch.startTime, end: batch.endTime },
    outputDir,
    reportPath,
    trajectoryPath,
    success: completion.success,
    error: completion.error,
    commitCount,
    dirty,
    durationMs: completion.durationMs,
    stepCount: completion.stepCount,
  };
  await writeFile(
    reportPath,
    JSON.stringify({ ...result, report: completion.report ?? "" }, null, 2),
    "utf-8",
  );
  log(
    `[reflect:batch-${batch.index}] ${
      result.success ? "done" : `FAILED: ${result.error ?? "unknown error"}`
    } (${commitCount} commit(s)${dirty ? ", uncommitted edits left" : ""})`,
  );
  return result;
}

/** Run all batches with bounded concurrency; results ordered by batch index. */
export async function runBatchReflections(
  params: RunBatchReflectionsParams,
): Promise<BatchReflectionResult[]> {
  const results: BatchReflectionResult[] = [];
  let next = 0;
  const workerCount = Math.max(
    1,
    Math.min(params.concurrency, params.batches.length),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < params.batches.length) {
      const batch = params.batches[next++];
      if (!batch) break;
      results.push(await runOneBatch(params, batch));
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.batchIndex - b.batchIndex);
  return results;
}
