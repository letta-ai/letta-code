/**
 * Per-task cron run history backed by JSONL files next to crons.json.
 *
 * This mirrors the reference shape: job state stays in one JSON file, while
 * each job/task gets an append-only `runs/<id>.jsonl` history file.
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type CronRunOutcome,
  type CronRunReason,
  type CronTask,
  getCronFilePath,
} from "./cron-file";

export type CronRunLogStatus = "ok" | "error" | "skipped";
export type CronRunLogAction =
  | "fire_started"
  | "enqueued"
  | "enqueue_failed"
  | "blocked"
  | "dequeued"
  | "turn_started"
  | "backend_run_started"
  | "completed"
  | "failed"
  | "cancelled"
  | "dropped"
  | "cleared"
  | "removed"
  | "pump_failed"
  | "listener_closed_before_drain"
  | "finished";

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: CronRunLogAction;
  status?: CronRunLogStatus;
  outcome?: CronRunOutcome;
  reason?: CronRunReason;
  error?: string;
  errorClass?: string;
  errorMessage?: string;
  summary?: string;
  agentId?: string;
  conversationId?: string;
  cronRunId?: string;
  runId?: string;
  backendRunId?: string;
  batchId?: string;
  runAtMs?: number;
  queueItemId?: string;
  queueLen?: number;
  queueLenAfter?: number;
  mergedCount?: number;
  blockedReason?: string;
  droppedReason?: string;
  clearedReason?: string;
  clearedCount?: number;
  removedReason?: string;
  stopReason?: string;
  schedulerPid?: number;
  schedulerToken?: string;
  schedulerStartedAt?: string;
  scheduledFor?: string | null;
  firedAt?: string;
  missedCount?: number;
  windowStart?: string;
  windowEnd?: string;
}

const CRON_RUN_LOG_ACTIONS = new Set<CronRunLogAction>([
  "fire_started",
  "enqueued",
  "enqueue_failed",
  "blocked",
  "dequeued",
  "turn_started",
  "backend_run_started",
  "completed",
  "failed",
  "cancelled",
  "dropped",
  "cleared",
  "removed",
  "pump_failed",
  "listener_closed_before_drain",
  "finished",
]);

export interface CronRunLogPage {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export const DEFAULT_CRON_RUN_LOG_MAX_BYTES = 2_000_000;
export const DEFAULT_CRON_RUN_LOG_KEEP_LINES = 2_000;

function assertSafeCronRunLogJobId(jobId: string): string {
  const trimmed = jobId.trim();
  if (!trimmed) {
    throw new Error("invalid cron run log job id");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error("invalid cron run log job id");
  }
  return trimmed;
}

export function resolveCronRunLogPath(params: {
  storePath: string;
  jobId: string;
}): string {
  const storePath = path.resolve(params.storePath);
  const runsDir = path.resolve(path.dirname(storePath), "runs");
  const safeJobId = assertSafeCronRunLogJobId(params.jobId);
  const resolvedPath = path.resolve(runsDir, `${safeJobId}.jsonl`);
  if (!resolvedPath.startsWith(`${runsDir}${path.sep}`)) {
    throw new Error("invalid cron run log job id");
  }
  return resolvedPath;
}

export function getCronRunLogPath(jobId: string): string {
  return resolveCronRunLogPath({ storePath: getCronFilePath(), jobId });
}

function setSecureDirMode(dirPath: string): void {
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}

function setSecureFileMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }
}

function pruneIfNeeded(
  filePath: string,
  opts: { maxBytes: number; keepLines: number },
): void {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    return;
  }
  if (size <= opts.maxBytes) {
    return;
  }

  const raw = readFileSync(filePath, "utf-8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const kept = lines.slice(Math.max(0, lines.length - opts.keepLines));
  writeFileSync(filePath, `${kept.join("\n")}\n`, { mode: 0o600 });
  setSecureFileMode(filePath);
}

export function appendCronRunLog(
  filePath: string,
  entry: CronRunLogEntry,
  opts?: { maxBytes?: number; keepLines?: number },
): void {
  const resolved = path.resolve(filePath);
  const runDir = path.dirname(resolved);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }
  setSecureDirMode(runDir);
  appendFileSync(resolved, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  setSecureFileMode(resolved);
  pruneIfNeeded(resolved, {
    maxBytes: opts?.maxBytes ?? DEFAULT_CRON_RUN_LOG_MAX_BYTES,
    keepLines: opts?.keepLines ?? DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  });
}

function parseAllRunLogEntries(raw: string, jobId?: string): CronRunLogEntry[] {
  if (!raw.trim()) {
    return [];
  }
  const entries: CronRunLogEntry[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    try {
      const obj = JSON.parse(line) as Partial<CronRunLogEntry> | null;
      if (!obj || typeof obj !== "object") {
        continue;
      }
      if (
        typeof obj.action !== "string" ||
        !CRON_RUN_LOG_ACTIONS.has(obj.action as CronRunLogAction)
      ) {
        continue;
      }
      if (typeof obj.jobId !== "string" || obj.jobId.trim().length === 0) {
        continue;
      }
      if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) {
        continue;
      }
      if (jobId && obj.jobId !== jobId) {
        continue;
      }
      entries.push({
        ts: obj.ts,
        jobId: obj.jobId,
        action: obj.action as CronRunLogAction,
        status: obj.status,
        outcome: obj.outcome,
        reason: obj.reason,
        error: obj.error,
        errorClass: obj.errorClass,
        errorMessage: obj.errorMessage,
        summary: obj.summary,
        agentId: obj.agentId,
        conversationId: obj.conversationId,
        cronRunId: obj.cronRunId,
        runId: obj.runId,
        backendRunId: obj.backendRunId,
        batchId: obj.batchId,
        runAtMs: obj.runAtMs,
        queueItemId: obj.queueItemId,
        queueLen: obj.queueLen,
        queueLenAfter: obj.queueLenAfter,
        mergedCount: obj.mergedCount,
        blockedReason: obj.blockedReason,
        droppedReason: obj.droppedReason,
        clearedReason: obj.clearedReason,
        clearedCount: obj.clearedCount,
        removedReason: obj.removedReason,
        stopReason: obj.stopReason,
        schedulerPid: obj.schedulerPid,
        schedulerToken: obj.schedulerToken,
        schedulerStartedAt: obj.schedulerStartedAt,
        scheduledFor: obj.scheduledFor,
        firedAt: obj.firedAt,
        missedCount: obj.missedCount,
        windowStart: obj.windowStart,
        windowEnd: obj.windowEnd,
      });
    } catch {
      // Ignore invalid lines.
    }
  }
  return entries;
}

export function readCronRunLogEntries(
  filePath: string,
  opts?: { limit?: number; jobId?: string },
): CronRunLogEntry[] {
  const limit = Math.max(1, Math.min(5000, Math.floor(opts?.limit ?? 200)));
  let raw = "";
  try {
    raw = readFileSync(path.resolve(filePath), "utf-8");
  } catch {
    return [];
  }
  return parseAllRunLogEntries(raw, opts?.jobId).slice(-limit);
}

export interface CronRunLogPageOptions {
  limit?: number;
  offset?: number;
  jobId?: string;
  /** Generic filter that matches public runId, backendRunId, or cronRunId. */
  runId?: string;
  /** Exact backend run id filter. */
  backendRunId?: string;
  /** Exact per-fire cron run id filter. */
  cronRunId?: string;
}

export function readCronRunLogEntriesPage(
  filePath: string,
  opts?: CronRunLogPageOptions,
): CronRunLogPage {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const genericRunId = opts?.runId?.trim();
  const backendRunId = opts?.backendRunId?.trim();
  const cronRunId = opts?.cronRunId?.trim();
  const entries = readCronRunLogEntries(filePath, {
    limit: 5000,
    jobId: opts?.jobId,
  })
    .filter((entry) => {
      if (
        genericRunId &&
        entry.runId !== genericRunId &&
        entry.backendRunId !== genericRunId &&
        entry.cronRunId !== genericRunId
      ) {
        return false;
      }
      if (backendRunId && entry.backendRunId !== backendRunId) {
        return false;
      }
      if (cronRunId && entry.cronRunId !== cronRunId) {
        return false;
      }
      return true;
    })
    .toSorted((a, b) => b.ts - a.ts);
  const pageEntries = entries.slice(offset, offset + limit);
  const nextOffset = offset + pageEntries.length;
  return {
    entries: pageEntries,
    total: entries.length,
    offset,
    limit,
    hasMore: nextOffset < entries.length,
    nextOffset: nextOffset < entries.length ? nextOffset : null,
  };
}

export type CronRunLogTaskEntryInput = Omit<
  CronRunLogEntry,
  "action" | "agentId" | "jobId" | "ts"
> & {
  action?: CronRunLogAction;
  ts?: number;
};

export function appendCronRunLogForTask(
  task: CronTask,
  entry: CronRunLogTaskEntryInput,
): void {
  const { action, ts, ...rest } = entry;
  appendCronRunLog(getCronRunLogPath(task.id), {
    ts: ts ?? Date.now(),
    jobId: task.id,
    action: action ?? "finished",
    agentId: task.agent_id,
    conversationId: task.conversation_id,
    ...rest,
  });
}

export type CronRunLogRunReference = {
  jobId: string;
  cronRunId: string;
  queueItemId?: string;
  agentId?: string;
  conversationId?: string;
};

export type CronRunLogRunEntryInput = Omit<
  CronRunLogEntry,
  "jobId" | "ts" | "cronRunId"
> & {
  ts?: number;
};

export function appendCronRunLogForCronRun(
  ref: CronRunLogRunReference,
  entry: CronRunLogRunEntryInput,
): void {
  const { ts, ...rest } = entry;
  appendCronRunLog(getCronRunLogPath(ref.jobId), {
    ts: ts ?? Date.now(),
    jobId: ref.jobId,
    cronRunId: ref.cronRunId,
    queueItemId: ref.queueItemId,
    agentId: ref.agentId,
    conversationId: ref.conversationId,
    ...rest,
  });
}

export function safeAppendCronRunLogForTask(
  task: CronTask,
  entry: Parameters<typeof appendCronRunLogForTask>[1],
): void {
  try {
    appendCronRunLogForTask(task, entry);
  } catch (err) {
    console.error(
      `[Cron] Error writing run log for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export function safeAppendCronRunLogForCronRun(
  ref: CronRunLogRunReference,
  entry: Parameters<typeof appendCronRunLogForCronRun>[1],
): void {
  try {
    appendCronRunLogForCronRun(ref, entry);
  } catch (err) {
    console.error(
      `[Cron] Error writing run log for cron run ${ref.cronRunId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
