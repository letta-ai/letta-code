import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import {
  createMemoryChangeJob,
  type MemoryChangeJob,
  type MemoryChangeJobSource,
  saveMemoryChangeJob,
} from "@/agent/memory-change-job";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import {
  type MemoryCommitAuthor,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import {
  enqueueMemoryWriterLane,
  memoryMutationLockDir,
  withMemoryMutationLock,
} from "@/agent/memory-mutation-coordinator";
import {
  buildMemoryWriterScope,
  commitMemoryWriterProposal,
  createMemoryWriterWorktree,
  discardMemoryWriterWorktree,
  integrateMemoryWriterWorktree,
  type MemoryWriterFinalizeResult,
  type MemoryWriterMemoryScope,
  type MemoryWriterWorktree,
  writeDurablePatchFile,
} from "@/agent/memory-writer-worktree";
import { recompileAgentSystemPrompt } from "@/agent/modify";
import { getBackend } from "@/backend";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";
import { settingsManager } from "@/settings-manager";
import { debugLog, debugWarn } from "@/utils/debug";
import { addToMessageQueue } from "@/utils/message-queue-bridge";

export interface EnqueueMemoryWriterJobParams {
  agentId?: string;
  conversationId?: string;
  instruction: string;
  source: MemoryChangeJobSource;
  sourceId?: string;
  wait?: boolean;
  model?: string;
  transcriptPath?: string;
}

export interface EnqueueMemoryWriterJobResult {
  jobId: string;
  status: "queued" | MemoryWriterFinalizeResult["status"];
  message: string;
  summary?: string;
  affectedPaths?: string[];
}

export interface MemoryWriterSpawnRequest {
  subagentType: string;
  prompt: string;
  description: string;
  model?: string;
  silentCompletion?: boolean;
  transcriptPath?: string;
  memoryScope?: MemoryWriterMemoryScope;
  parentScope?: { agentId: string; conversationId: string };
  onComplete?: (result: {
    success: boolean;
    error?: string;
    agentId?: string;
    conversationId?: string;
    report?: string;
  }) => void | Promise<void>;
}

export interface MemoryWriterLauncherDeps {
  spawnBackgroundSubagentTask?: (args: MemoryWriterSpawnRequest) => unknown;
  recompileAgentSystemPrompt?: typeof recompileAgentSystemPrompt;
  addToMessageQueue?: typeof addToMessageQueue;
  syncPendingMemoryCommitsAfterTurn?: typeof syncPendingMemoryCommitsAfterTurn;
  resolveAuthor?: (agentId: string) => Promise<MemoryCommitAuthor>;
}

const jobCompletions = new Map<string, Promise<MemoryWriterFinalizeResult>>();

export function isMemoryWriterSubagentType(type: string): boolean {
  return type === "memory" || type === "memory-writer";
}

function resolveParentScope(params: EnqueueMemoryWriterJobParams): {
  agentId: string;
  conversationId: string;
} {
  const agentId = (params.agentId ?? getCurrentAgentId()).trim();
  if (!agentId) {
    throw new Error("remember: unable to resolve parent agent id");
  }
  let conversationId = params.conversationId?.trim() ?? "";
  if (!conversationId) {
    try {
      conversationId = (getConversationId() ?? "default").trim();
    } catch {
      conversationId = "default";
    }
  }
  return { agentId, conversationId: conversationId || "default" };
}

async function defaultResolveAuthor(
  agentId: string,
): Promise<MemoryCommitAuthor> {
  let agentName = "";
  try {
    const agent = await getBackend().retrieveAgent(agentId);
    agentName = (agent.name || "").trim();
  } catch {
    // Best-effort fallback below.
  }
  if (!agentName) {
    agentName = (process.env.AGENT_NAME || "").trim() || agentId;
  }
  return {
    agentId,
    authorName: agentName,
    authorEmail: `${agentId}@letta.com`,
  };
}

function formatQueuedMessage(jobId: string): string {
  return (
    `Memory update queued (job ${jobId}). Remembering in background… ` +
    "Do not claim this was already saved."
  );
}

function formatCompletionReminder(result: MemoryWriterFinalizeResult): string {
  if (result.status === "applied") {
    const files =
      result.affectedPaths.length > 0
        ? result.affectedPaths.join(", ")
        : "memory files";
    return `${SYSTEM_REMINDER_OPEN}\nMemory updated: ${files}\n${SYSTEM_REMINDER_CLOSE}`;
  }
  if (result.status === "noop") {
    return `${SYSTEM_REMINDER_OPEN}\nNo memory change was needed; this was already captured.\n${SYSTEM_REMINDER_CLOSE}`;
  }
  if (result.status === "needs_review") {
    return `${SYSTEM_REMINDER_OPEN}\nMemory update needs review. ${result.summary} Branch: ${result.branchName}\n${SYSTEM_REMINDER_CLOSE}`;
  }
  return `${SYSTEM_REMINDER_OPEN}\nMemory update failed: ${result.summary}\n${SYSTEM_REMINDER_CLOSE}`;
}

function parseWriterReportStatus(
  report: string | undefined,
): "noop" | "needs_clarification" | "applied" {
  const text = report?.trim() ?? "";
  if (/STATUS:\s*needs_clarification/i.test(text)) {
    return "needs_clarification";
  }
  if (/STATUS:\s*noop/i.test(text)) {
    return "noop";
  }
  return "applied";
}

function summarizeInstruction(instruction: string): string {
  const trimmed = instruction.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 72) return trimmed;
  return `${trimmed.slice(0, 69)}...`;
}

export async function enqueueMemoryWriterJob(
  params: EnqueueMemoryWriterJobParams,
  deps: MemoryWriterLauncherDeps = {},
): Promise<EnqueueMemoryWriterJobResult> {
  const instruction = params.instruction.trim();
  if (!instruction) {
    throw new Error("remember: 'instruction' must be a non-empty string");
  }

  const { agentId, conversationId } = resolveParentScope(params);
  if (!settingsManager.isMemfsEnabled(agentId)) {
    throw new Error(
      "remember: memory filesystem is not enabled for this agent",
    );
  }

  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  const jobId = randomUUID();
  const job = createMemoryChangeJob({
    jobId,
    agentId,
    conversationId,
    instruction,
    source: params.source,
    sourceId: params.sourceId,
  });
  await saveMemoryChangeJob(memoryDir, job);

  const completion = enqueueMemoryWriterLane(agentId, () =>
    runMemoryWriterJob(job, memoryDir, params, deps),
  );
  jobCompletions.set(jobId, completion);
  void completion.finally(() => {
    if (jobCompletions.get(jobId) === completion) {
      jobCompletions.delete(jobId);
    }
  });

  if (params.wait) {
    const result = await completion;
    return {
      jobId,
      status: result.status,
      message: result.summary,
      summary: result.summary,
      affectedPaths: result.affectedPaths,
    };
  }

  return {
    jobId,
    status: "queued",
    message: formatQueuedMessage(jobId),
  };
}

async function failJob(
  job: MemoryChangeJob,
  memoryDir: string,
  summary: string,
  worktree?: MemoryWriterWorktree,
): Promise<MemoryWriterFinalizeResult> {
  if (worktree) {
    await discardMemoryWriterWorktree(worktree).catch(() => {});
  }
  job.status = "failed_retryable";
  job.error = summary;
  job.summary = summary;
  await saveMemoryChangeJob(memoryDir, job);
  return {
    status: "failed",
    parentMemoryDir: memoryDir,
    worktreeDir: worktree?.worktreeDir ?? "",
    branchName: worktree?.branchName ?? "",
    commitCount: 0,
    affectedPaths: [],
    summary,
    error: summary,
  };
}

async function runMemoryWriterJob(
  job: MemoryChangeJob,
  memoryDir: string,
  params: EnqueueMemoryWriterJobParams,
  deps: MemoryWriterLauncherDeps,
): Promise<MemoryWriterFinalizeResult> {
  const spawn = deps.spawnBackgroundSubagentTask;
  if (!spawn) {
    return failJob(
      job,
      memoryDir,
      "remember: spawnBackgroundSubagentTask is required",
    );
  }

  job.status = "drafting";
  await saveMemoryChangeJob(memoryDir, job);

  let worktree: MemoryWriterWorktree;
  try {
    worktree = await createMemoryWriterWorktree({
      parentMemoryDir: memoryDir,
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    return failJob(job, memoryDir, summary);
  }

  job.baseHead = worktree.baseHead;
  job.worktreeDir = worktree.worktreeDir;
  job.branchName = worktree.branchName;
  await saveMemoryChangeJob(memoryDir, job);

  try {
    return await new Promise<MemoryWriterFinalizeResult>((resolve, reject) => {
      try {
        spawn({
          subagentType: "memory-writer",
          prompt: buildMemoryWriterPrompt(job.instruction),
          description: summarizeInstruction(job.instruction),
          model: params.model,
          silentCompletion: true,
          transcriptPath: params.transcriptPath,
          memoryScope: buildMemoryWriterScope(worktree),
          parentScope: {
            agentId: job.agentId,
            conversationId: job.conversationId,
          },
          onComplete: async (result) => {
            try {
              const finalized = await finalizeMemoryWriterJob({
                job,
                memoryDir,
                worktree,
                childSuccess: result.success,
                childError: result.error,
                childAgentId: result.agentId,
                childConversationId: result.conversationId,
                report: result.report,
                notify: params.wait !== true,
                deps,
              });
              resolve(finalized);
            } catch (error) {
              reject(error);
            }
          },
        });
      } catch (error) {
        reject(error);
      }
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    return failJob(job, memoryDir, summary, worktree);
  }
}

export async function finalizeMemoryWriterJob(params: {
  job: MemoryChangeJob;
  memoryDir: string;
  worktree: MemoryWriterWorktree;
  childSuccess: boolean;
  childError?: string;
  childAgentId?: string;
  childConversationId?: string;
  report?: string;
  notify?: boolean;
  deps?: MemoryWriterLauncherDeps;
}): Promise<MemoryWriterFinalizeResult> {
  const { job, memoryDir, worktree } = params;
  const deps = params.deps ?? {};
  const notify = params.notify !== false;
  job.childAgentId = params.childAgentId;
  job.childConversationId = params.childConversationId;

  const reportStatus = parseWriterReportStatus(params.report);
  if (!params.childSuccess) {
    await discardMemoryWriterWorktree(worktree);
    job.status = "failed_retryable";
    job.error = params.childError;
    job.summary = params.childError || "Memory writer failed";
    await saveMemoryChangeJob(memoryDir, job);
    const failed: MemoryWriterFinalizeResult = {
      status: "failed",
      parentMemoryDir: memoryDir,
      worktreeDir: worktree.worktreeDir,
      branchName: worktree.branchName,
      commitCount: 0,
      affectedPaths: [],
      summary: job.summary,
      error: params.childError,
    };
    if (notify) notifyParent(job, failed, deps);
    return failed;
  }

  if (reportStatus === "needs_clarification") {
    await discardMemoryWriterWorktree(worktree);
    job.status = "needs_clarification";
    job.summary =
      params.report?.trim() ||
      "Memory writer needs clarification; no changes were committed.";
    await saveMemoryChangeJob(memoryDir, job);
    const failed: MemoryWriterFinalizeResult = {
      status: "failed",
      parentMemoryDir: memoryDir,
      worktreeDir: worktree.worktreeDir,
      branchName: worktree.branchName,
      commitCount: 0,
      affectedPaths: [],
      summary: job.summary,
    };
    if (notify) notifyParent(job, failed, deps);
    return failed;
  }

  const author = await (deps.resolveAuthor ?? defaultResolveAuthor)(
    job.agentId,
  );
  job.status = "proposed";
  await saveMemoryChangeJob(memoryDir, job);

  const committed = await commitMemoryWriterProposal({
    worktree,
    author,
    jobId: job.jobId,
    writerAgentId: params.childAgentId,
    reason: summarizeInstruction(job.instruction),
  });
  job.proposalHead = committed.sha;
  job.affectedPaths = committed.affectedPaths;

  const integration = await withMemoryMutationLock(
    memoryMutationLockDir(memoryDir),
    async () => {
      job.status = "integrating";
      await saveMemoryChangeJob(memoryDir, job);
      return integrateMemoryWriterWorktree({
        worktree,
        shouldIntegrate: true,
        preserveOnFailure: true,
      });
    },
  );

  if (integration.status === "needs_review" && integration.patch) {
    const patchPath = join(
      memoryDir,
      "..",
      "memory-jobs",
      `${job.jobId}.patch`,
    );
    await writeDurablePatchFile(patchPath, integration.patch);
    job.patchPath = patchPath;
  }

  if (integration.status === "applied") {
    job.status = "syncing";
    await saveMemoryChangeJob(memoryDir, job);
    try {
      const sync =
        deps.syncPendingMemoryCommitsAfterTurn ??
        syncPendingMemoryCommitsAfterTurn;
      await sync(job.agentId, { memoryDir });
    } catch (error) {
      debugWarn(
        "memory",
        `Memory writer push/sync failed for job ${job.jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    job.status = "applied";
    job.summary = integration.summary;
    job.affectedPaths = integration.affectedPaths;
    await saveMemoryChangeJob(memoryDir, job);
    try {
      const recompile =
        deps.recompileAgentSystemPrompt ?? recompileAgentSystemPrompt;
      await recompile(job.conversationId, job.agentId);
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to recompile after memory-writer job ${job.jobId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    emitMemoryUpdated(integration.affectedPaths);
  } else if (integration.status === "noop") {
    job.status = "noop";
    job.summary = integration.summary;
    await saveMemoryChangeJob(memoryDir, job);
  } else {
    job.status =
      integration.status === "needs_review"
        ? "needs_review"
        : "failed_retryable";
    job.summary = integration.summary;
    job.error = integration.error;
    await saveMemoryChangeJob(memoryDir, job);
  }

  if (notify) notifyParent(job, integration, deps);
  debugLog(
    "memory",
    "memory-writer job %s status=%s paths=%s",
    job.jobId,
    job.status,
    (integration.affectedPaths ?? []).join(","),
  );
  return integration;
}

function notifyParent(
  job: MemoryChangeJob,
  result: MemoryWriterFinalizeResult,
  deps: MemoryWriterLauncherDeps,
): void {
  const enqueue = deps.addToMessageQueue ?? addToMessageQueue;
  try {
    enqueue({
      kind: "user",
      text: formatCompletionReminder(result),
      agentId: job.agentId,
      conversationId: job.conversationId,
    });
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to queue memory-writer completion for job ${job.jobId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function emitMemoryUpdated(affectedPaths: string[]): void {
  try {
    // Lazy-import to avoid circular deps — this file is loaded before WS infra.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getActiveRuntime } = require("@/websocket/listener/runtime") as {
      getActiveRuntime: () => {
        socket: { readyState: number; send: (data: string) => void } | null;
      } | null;
    };
    const runtime = getActiveRuntime();
    const socket = runtime?.socket;
    if (!socket || socket.readyState !== 1) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "memory_updated",
        affected_paths: affectedPaths,
        timestamp: Date.now(),
      }),
    );
  } catch {
    // Best-effort — never break writer finalization for a push event.
  }
}

export function buildMemoryWriterPrompt(instruction: string): string {
  return [
    "You are a harness-owned memory writer. Edit only files under $MEMORY_DIR using propose_memory_patch.",
    "Do not run git, do not commit, and do not modify files outside the memory worktree.",
    "If nothing needs to change, reply with `STATUS: noop`.",
    "If the request is too ambiguous to write safely, reply with `STATUS: needs_clarification` and a focused question. Do not patch.",
    "Otherwise apply the minimum surgical edits, keep frontmatter valid, and end with `STATUS: applied` plus a short path list.",
    "",
    "<memory_write_request>",
    instruction.trim(),
    "</memory_write_request>",
  ].join("\n");
}
