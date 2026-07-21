/**
 * In-process cron scheduler for the WS listener.
 *
 * On start:
 * 1. Claims the scheduler lease in crons.json
 * 2. Starts a setInterval that fires every 60s
 * 3. On each tick: reads active tasks, checks cron match against current time,
 *    enqueues matching tasks into their ConversationRuntime's queueRuntime,
 *    and kicks the queue pump
 * 4. Runs GC every 60 minutes
 *
 * On stop: clears interval, releases lease.
 */

import { getBackend } from "@/backend";
import type { CronPromptQueueItem, DequeuedBatch } from "@/queue/queue-runtime";
import { ensureConversationQueueRuntime } from "@/websocket/listener/conversation-runtime";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import {
  getActiveRuntime,
  getOrCreateConversationRuntime,
  safeEmitWsEvent,
} from "@/websocket/listener/runtime";
import {
  isListenerTransportOpen,
  type ListenerTransport,
} from "@/websocket/listener/transport";
import type {
  IncomingMessage,
  StartListenerOptions,
} from "@/websocket/listener/types";
import {
  type CronRunOutcome,
  type CronRunReason,
  type CronTask,
  claimSchedulerLease,
  garbageCollect,
  getActiveTasks,
  getCronFileMtime,
  getTask,
  releaseSchedulerLease,
  updateTask,
  verifySchedulerLease,
} from "./cron-file";
import { cronMatchesTime, isValidCron } from "./parse-interval";
import {
  type CronPromptTiming,
  formatCronPrompt,
  getIntendedCronOccurrence,
} from "./prompt";
import { safeAppendCronRunLogForTask } from "./run-log";

export {
  type CronPromptTiming,
  formatCronPrompt,
  formatTimezoneQualifiedIso,
  getIntendedCronOccurrence,
} from "./prompt";

// ── Types ───────────────────────────────────────────────────────────

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

interface SchedulerState {
  token: string;
  tickInterval: NodeJS.Timeout;
  gcInterval: NodeJS.Timeout;
  socket: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
  /** Last mtime of crons.json — skip re-reads when unchanged. */
  lastMtime: number;
  /** Cached active tasks (refreshed on file change). */
  cachedTasks: CronTask[];
  /** Set of task IDs that fired this minute (prevent double-fire). */
  firedThisMinute: Set<string>;
  /** Minute key for the current tick (e.g. "2026-03-26T00:15"). */
  lastMinuteKey: string;
  /** Pending jitter-delayed timers — cleared on stop/lease loss. */
  pendingTimers: Set<NodeJS.Timeout>;
}

let schedulerState: SchedulerState | null = null;

/**
 * Listener context stored independently of the scheduler lease.
 * runCronTaskNow ("Send now") only needs an active listener — it doesn't
 * need the tick loop or the lease. This lets it work even when another
 * process holds the scheduler lease (e.g. desktop app vs local dev server).
 */
let listenerFireContext: {
  socket: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
} | null = null;

// ── Constants ───────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 60 * 60_000; // 1 hour
const LEASE_RETRY_MS = 30_000; // 30 seconds between lease claim retries
const MAX_LEASE_RETRIES = 3;
const NEW_CONVERSATION_TARGET = "new";

// ── Helpers ─────────────────────────────────────────────────────────

export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function wrapCronPrompt(
  task: CronTask,
  timing: CronPromptTiming,
): string {
  return formatCronPrompt(task, timing);
}

function getCronConversationSummary(task: CronTask): string {
  return `[Schedule] ${task.name}`;
}

async function resolveCronFireConversationId(
  task: CronTask,
): Promise<string | undefined> {
  if (task.conversation_id === NEW_CONVERSATION_TARGET) {
    const conversation = await getBackend().createConversation({
      agent_id: task.agent_id,
      summary: getCronConversationSummary(task),
    });
    return conversation.id;
  }

  return task.conversation_id === "default" ? undefined : task.conversation_id;
}

function emitCronsUpdated(
  socket: ListenerTransport,
  task: CronTask,
  conversationId?: string | null,
): void {
  if (!isListenerTransportOpen(socket)) {
    return;
  }

  const payload = {
    type: "crons_updated",
    timestamp: Date.now(),
    agent_id: task.agent_id,
    conversation_id: conversationId ?? task.conversation_id,
  };

  try {
    socket.send(JSON.stringify(payload));
    safeEmitWsEvent("send", "protocol", payload);
  } catch (err) {
    console.error(
      `[Cron] Error sending crons_updated for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Core tick logic ─────────────────────────────────────────────────

function refreshTaskCache(state: SchedulerState): void {
  const mtime = getCronFileMtime();
  if (mtime !== state.lastMtime) {
    state.cachedTasks = getActiveTasks();
    state.lastMtime = mtime;
  }
}

function setLastRunOutcome(
  taskId: string,
  input: {
    outcome: CronRunOutcome;
    reason: CronRunReason;
    runAt: Date;
    error?: string | null;
    missedAt?: Date;
    missedCount?: number;
  },
): void {
  const runAtIso = input.runAt.toISOString();
  updateTask(taskId, (t) => {
    t.last_run_at = runAtIso;
    t.last_run_outcome = input.outcome;
    t.last_run_reason = input.reason;
    t.last_run_error = input.error ?? null;

    if (input.outcome === "missed") {
      const missedCount = Math.max(1, input.missedCount ?? 1);
      t.last_missed_at = input.missedAt?.toISOString() ?? runAtIso;
      t.missed_count = (t.missed_count ?? 0) + missedCount;
    }

    if (input.outcome === "failed") {
      t.failed_count = (t.failed_count ?? 0) + 1;
    }
  });
}

export function shouldFireTask(task: CronTask, now: Date): boolean {
  // One-shot: check if scheduled_for is now or past (jitter applied to scheduled time)
  if (!task.recurring && task.scheduled_for) {
    const scheduledMs =
      new Date(task.scheduled_for).getTime() + task.jitter_offset_ms;
    return scheduledMs <= now.getTime();
  }

  // Recurring: check if the cron expression matches this minute.
  // Jitter is applied as a setTimeout delay at the call site, not here.
  return cronMatchesTime(task.cron, now, task.timezone);
}

function getInvalidCronError(cron: string): string {
  return `Invalid cron expression "${cron}". Delete and recreate this schedule.`;
}

function hasReportedInvalidCron(task: CronTask): boolean {
  return (
    task.last_run_outcome === "failed" &&
    task.last_run_reason === "invalid_cron" &&
    task.last_run_error === getInvalidCronError(task.cron)
  );
}

/**
 * Persist a visible failure for legacy recurring tasks that predate current
 * cron validation. Keep the task active so the user can inspect and replace
 * it instead of silently dropping it or garbage-collecting its definition.
 */
export function handleInvalidRecurringTask(task: CronTask, now: Date): boolean {
  if (!task.recurring || isValidCron(task.cron)) return false;

  const error = getInvalidCronError(task.cron);
  if (hasReportedInvalidCron(task)) return true;

  setLastRunOutcome(task.id, {
    outcome: "failed",
    reason: "invalid_cron",
    runAt: now,
    error,
  });
  safeAppendCronRunLogForTask(task, {
    status: "error",
    outcome: "failed",
    reason: "invalid_cron",
    error,
    runAtMs: now.getTime(),
  });
  return true;
}

async function fireCronTask(
  task: CronTask,
  timing: CronPromptTiming,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): Promise<boolean> {
  const listener = getActiveRuntime();
  if (!listener) {
    setLastRunOutcome(task.id, {
      outcome: "failed",
      reason: "runtime_unavailable",
      runAt: timing.schedulerNow,
      error: "No active runtime",
    });
    safeAppendCronRunLogForTask(task, {
      status: "error",
      outcome: "failed",
      reason: "runtime_unavailable",
      error: "No active runtime",
      runAtMs: timing.schedulerNow.getTime(),
      scheduledFor: task.scheduled_for,
    });
    return false;
  }

  let targetConversationId: string | undefined;
  try {
    targetConversationId = await resolveCronFireConversationId(task);
  } catch (err) {
    safeAppendCronRunLogForTask(task, {
      status: "error",
      error:
        err instanceof Error ? err.message : "failed to resolve conversation",
      runAtMs: timing.schedulerNow.getTime(),
      scheduledFor: task.scheduled_for,
    });
    return false;
  }

  const rawRuntime = getOrCreateConversationRuntime(
    listener,
    task.agent_id,
    targetConversationId,
  );

  if (!rawRuntime) {
    setLastRunOutcome(task.id, {
      outcome: "failed",
      reason: "runtime_unavailable",
      runAt: timing.schedulerNow,
      error: "Conversation runtime unavailable",
    });
    safeAppendCronRunLogForTask(task, {
      status: "error",
      outcome: "failed",
      reason: "runtime_unavailable",
      error: "Conversation runtime unavailable",
      runAtMs: timing.schedulerNow.getTime(),
      scheduledFor: task.scheduled_for,
    });
    return false;
  }

  // Ensure the queue runtime is initialized (getOrCreateConversationRuntime
  // leaves queueRuntime as null — the listener's scoped helper initializes it).
  const conversationRuntime = ensureConversationQueueRuntime(
    listener,
    rawRuntime,
  );

  const text = wrapCronPrompt(task, timing);

  const queuedItem = conversationRuntime.queueRuntime.enqueue({
    kind: "cron_prompt",
    source: "cron" as import("@/types/protocol").QueueItemSource,
    text,
    cronTaskId: task.id,
    agentId: task.agent_id,
    conversationId: targetConversationId ?? "default",
  } as Omit<CronPromptQueueItem, "id" | "enqueuedAt">);

  if (!queuedItem) {
    setLastRunOutcome(task.id, {
      outcome: "failed",
      reason: "queue_full",
      runAt: timing.schedulerNow,
      error: "queue buffer limit",
    });
    safeAppendCronRunLogForTask(task, {
      status: "error",
      outcome: "failed",
      reason: "queue_full",
      error: "queue buffer limit",
      runAtMs: timing.schedulerNow.getTime(),
      scheduledFor: task.scheduled_for,
    });
    return false;
  }

  scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);

  // Update task state
  const nowIso = timing.schedulerNow.toISOString();
  if (task.recurring) {
    updateTask(task.id, (t) => {
      t.last_fired_at = nowIso;
      t.fire_count += 1;
      t.last_run_at = nowIso;
      t.last_run_outcome = "queued";
      t.last_run_reason = "scheduled_time_matched";
      t.last_run_error = null;
    });
  } else {
    // One-shot: mark as fired
    updateTask(task.id, (t) => {
      t.status = "fired";
      t.fired_at = nowIso;
      t.last_fired_at = nowIso;
      t.fire_count = 1;
      t.last_run_at = nowIso;
      t.last_run_outcome = "queued";
      t.last_run_reason = "one_off_due";
      t.last_run_error = null;
    });
  }

  safeAppendCronRunLogForTask(task, {
    status: "ok",
    outcome: "queued",
    reason: task.recurring ? "scheduled_time_matched" : "one_off_due",
    runAtMs: timing.schedulerNow.getTime(),
    queueItemId: queuedItem.id,
    scheduledFor: task.scheduled_for,
    firedAt: nowIso,
    conversationId: targetConversationId ?? "default",
  });
  emitCronsUpdated(socket, task, targetConversationId ?? "default");
  return true;
}

/** Returns true if the task was marked as missed (caller should skip firing). */
export function handleMissedOneShot(task: CronTask, now: Date): boolean {
  if (task.recurring || !task.scheduled_for) return false;
  // A one-shot is "missed" if it's been more than 5 minutes past scheduled time
  const scheduledMs = new Date(task.scheduled_for).getTime();
  const missThreshold = 5 * 60_000;
  if (now.getTime() > scheduledMs + missThreshold && task.status === "active") {
    const reason: CronRunReason =
      task.last_run_outcome === "failed"
        ? (task.last_run_reason ?? "scheduler_error")
        : "scheduler_inactive";
    const error =
      task.last_run_outcome === "failed" ? task.last_run_error : null;
    updateTask(task.id, (t) => {
      t.status = "missed";
      t.missed_at = now.toISOString();
      t.last_run_at = now.toISOString();
      t.last_run_outcome = "missed";
      t.last_run_reason = reason;
      t.last_run_error = error ?? null;
      t.last_missed_at = task.scheduled_for;
      t.missed_count = (t.missed_count ?? 0) + 1;
    });
    safeAppendCronRunLogForTask(task, {
      status: "skipped",
      outcome: "missed",
      reason,
      summary: "missed",
      error: error ?? undefined,
      runAtMs: now.getTime(),
      scheduledFor: task.scheduled_for,
      missedCount: 1,
    });
    return true;
  }
  return false;
}

/** Apply scheduler lifecycle checks shared by the WS and TUI tick loops. */
export function handleTaskPreflight(task: CronTask, now: Date): boolean {
  return (
    handleInvalidRecurringTask(task, now) || handleMissedOneShot(task, now)
  );
}

export async function runCronTaskNow(taskId: string): Promise<{
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}> {
  const task = getTask(taskId);
  if (!task) {
    return { success: false, found: false, error: "Schedule not found" };
  }

  if (task.status !== "active") {
    return {
      success: false,
      found: true,
      task,
      error: "Schedule is not active",
    };
  }

  // Prefer the full scheduler state, but fall back to the listener context.
  // "Send now" only needs the active listener — not the tick loop or the lease.
  const ctx = schedulerState ?? listenerFireContext;
  if (!ctx) {
    return {
      success: false,
      found: true,
      task,
      error: "Cron scheduler is not running",
    };
  }

  const schedulerNow = new Date();
  const fired = await fireCronTask(
    task,
    {
      intendedOccurrence: getIntendedCronOccurrence(task, schedulerNow),
      schedulerNow,
    },
    ctx.socket,
    ctx.opts,
    ctx.processQueuedTurn,
  );

  if (!fired) {
    return {
      success: false,
      found: true,
      task,
      error: "Failed to enqueue schedule run",
    };
  }

  if (schedulerState) {
    refreshTaskCache(schedulerState);
  }
  return { success: true, found: true, task: getTask(taskId) ?? task };
}

function tick(
  state: SchedulerState,
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  // Verify we still hold the lease
  if (!verifySchedulerLease(state.token)) {
    console.error("[Cron] Scheduler lease lost. Stopping.");
    stopScheduler();
    return;
  }

  const matchedAt = new Date();
  const currentMinuteKey = minuteKey(matchedAt);

  // Reset per-minute dedup when minute changes
  if (currentMinuteKey !== state.lastMinuteKey) {
    state.firedThisMinute.clear();
    state.lastMinuteKey = currentMinuteKey;
  }

  refreshTaskCache(state);

  for (const task of state.cachedTasks) {
    if (task.status !== "active") continue;

    // Older clients could persist expressions that the current cron dialect
    // rejects. Surface that state once rather than silently never firing.
    const invalidCronWasReported = hasReportedInvalidCron(task);
    const invalidCron = task.recurring && !isValidCron(task.cron);
    if (handleTaskPreflight(task, matchedAt)) {
      if (invalidCron && !invalidCronWasReported) {
        emitCronsUpdated(socket, task);
      }
      continue;
    }

    // Per-minute dedup
    if (state.firedThisMinute.has(task.id)) continue;

    if (shouldFireTask(task, matchedAt)) {
      state.firedThisMinute.add(task.id);
      const intendedOccurrence = getIntendedCronOccurrence(task, matchedAt);

      // Apply jitter as a real delay for recurring tasks so that tasks with
      // different jitter values actually fire at different times.
      const jitterMs = task.recurring ? task.jitter_offset_ms : 0;
      const taskId = task.id;
      const doFire = () => {
        // Revalidate before firing: scheduler may have stopped, lease may
        // have been lost, or the task may have been deleted/cancelled during
        // the jitter window.
        if (!schedulerState) return;
        const freshTask = getTask(taskId);
        if (!freshTask || freshTask.status !== "active") return;

        const schedulerNow = new Date();
        void fireCronTask(
          freshTask,
          { intendedOccurrence, schedulerNow },
          socket,
          opts,
          processQueuedTurn,
        ).catch((err) => {
          console.error(`[Cron] Error firing task ${taskId}:`, err);
          setLastRunOutcome(freshTask.id, {
            outcome: "failed",
            reason: "scheduler_error",
            runAt: schedulerNow,
            error: err instanceof Error ? err.message : String(err),
          });
          safeAppendCronRunLogForTask(freshTask, {
            status: "error",
            outcome: "failed",
            reason: "scheduler_error",
            error: err instanceof Error ? err.message : String(err),
            runAtMs: schedulerNow.getTime(),
            scheduledFor: freshTask.scheduled_for,
          });
        });
      };

      if (jitterMs > 0) {
        const handle = setTimeout(() => {
          state.pendingTimers.delete(handle);
          doFire();
        }, jitterMs);
        state.pendingTimers.add(handle);
      } else {
        doFire();
      }
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Start the cron scheduler. Should be called when the WS listener connects.
 * No-ops if already running.
 *
 * If the lease claim fails (e.g. another process briefly holds it after a
 * crash/restart), the scheduler will retry up to MAX_LEASE_RETRIES times
 * with LEASE_RETRY_MS between attempts. The user is warned that cron
 * tasks won't fire until the scheduler starts.
 */
export function startScheduler(
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
  _retryCount = 0,
): void {
  // Always store the listener context so runCronTaskNow ("Send now") works
  // even when this process doesn't hold the scheduler lease.
  listenerFireContext = { socket, opts, processQueuedTurn };

  if (schedulerState) return;

  let token: string;
  try {
    token = claimSchedulerLease();
  } catch (err) {
    if (_retryCount < MAX_LEASE_RETRIES) {
      console.warn(
        `[Cron] Could not claim scheduler lease (attempt ${_retryCount + 1}/${MAX_LEASE_RETRIES + 1}): ${err instanceof Error ? err.message : err}`,
      );
      console.warn(
        "[Cron] Cron tasks will not fire until the scheduler starts. Retrying...",
      );
      setTimeout(
        () => startScheduler(socket, opts, processQueuedTurn, _retryCount + 1),
        LEASE_RETRY_MS,
      );
    } else {
      console.error(
        `[Cron] Failed to claim scheduler lease after ${MAX_LEASE_RETRIES + 1} attempts. Cron tasks will not fire.`,
      );
      console.error(
        "[Cron] Another process may hold the lease. Restart Letta Code to retry.",
      );
    }
    return;
  }

  const now = new Date();
  const state: SchedulerState = {
    token,
    tickInterval: null as unknown as NodeJS.Timeout,
    gcInterval: null as unknown as NodeJS.Timeout,
    socket,
    opts,
    processQueuedTurn,
    lastMtime: 0,
    cachedTasks: [],
    firedThisMinute: new Set(),
    lastMinuteKey: minuteKey(now),
    pendingTimers: new Set(),
  };

  // Initial tick
  tick(state, socket, opts, processQueuedTurn);

  state.tickInterval = setInterval(() => {
    tick(state, socket, opts, processQueuedTurn);
  }, TICK_INTERVAL_MS);

  state.gcInterval = setInterval(() => {
    try {
      const removed = garbageCollect();
      if (removed > 0) {
        state.lastMtime = 0; // Force cache refresh
      }
    } catch (err) {
      console.error("[Cron] GC error:", err);
    }
  }, GC_INTERVAL_MS);

  schedulerState = state;
}

/**
 * Stop the cron scheduler. Should be called when the WS listener disconnects.
 */
export function stopScheduler(): void {
  listenerFireContext = null;
  if (!schedulerState) return;

  clearInterval(schedulerState.tickInterval);
  clearInterval(schedulerState.gcInterval);

  // Cancel all jitter-delayed fires that haven't executed yet.
  for (const handle of schedulerState.pendingTimers) {
    clearTimeout(handle);
  }
  schedulerState.pendingTimers.clear();

  try {
    releaseSchedulerLease(schedulerState.token);
  } catch {
    // Best effort
  }

  schedulerState = null;
}

/**
 * Check if the scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return schedulerState !== null;
}
