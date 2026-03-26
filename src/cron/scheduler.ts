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

import type WebSocket from "ws";
import type { CronPromptQueueItem, DequeuedBatch } from "../queue/queueRuntime";
import { ensureConversationQueueRuntime } from "../websocket/listener/client";
import { scheduleQueuePump } from "../websocket/listener/queue";
import {
  getActiveRuntime,
  getOrCreateConversationRuntime,
} from "../websocket/listener/runtime";
import type {
  IncomingMessage,
  StartListenerOptions,
} from "../websocket/listener/types";
import {
  type CronTask,
  claimSchedulerLease,
  cronMatchesTime,
  garbageCollect,
  getActiveTasks,
  getCronFileMtime,
  getTask,
  releaseSchedulerLease,
  updateTask,
  verifySchedulerLease,
} from "./index";

// ── Types ───────────────────────────────────────────────────────────

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

interface SchedulerState {
  token: string;
  tickInterval: NodeJS.Timeout;
  gcInterval: NodeJS.Timeout;
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

// ── Constants ───────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 60 * 60_000; // 1 hour

// ── Helpers ─────────────────────────────────────────────────────────

function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function wrapCronPrompt(task: CronTask): string {
  return [
    "<cron_prompt>",
    `<task_id>${task.id}</task_id>`,
    `<cron>${task.cron}</cron>`,
    task.recurring
      ? `<fire_count>${task.fire_count + 1}</fire_count>`
      : "<one_shot>true</one_shot>",
    `<prompt>${task.prompt}</prompt>`,
    "</cron_prompt>",
  ].join("\n");
}

// ── Core tick logic ─────────────────────────────────────────────────

function refreshTaskCache(state: SchedulerState): void {
  const mtime = getCronFileMtime();
  if (mtime !== state.lastMtime) {
    state.cachedTasks = getActiveTasks();
    state.lastMtime = mtime;
  }
}

function shouldFireTask(task: CronTask, now: Date): boolean {
  // Check expiry for recurring tasks
  if (task.recurring && task.expires_at) {
    if (new Date(task.expires_at).getTime() <= now.getTime()) {
      return false; // Will be handled by expiry check
    }
  }

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

function fireCronTask(
  task: CronTask,
  now: Date,
  socket: WebSocket,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  const listener = getActiveRuntime();
  if (!listener) return;

  const rawRuntime = getOrCreateConversationRuntime(
    listener,
    task.agent_id,
    task.conversation_id === "default" ? undefined : task.conversation_id,
  );

  if (!rawRuntime) return;

  // Ensure the queue runtime is initialized (getOrCreateConversationRuntime
  // leaves queueRuntime as null — the listener's scoped helper initializes it).
  const conversationRuntime = ensureConversationQueueRuntime(
    listener,
    rawRuntime,
  );

  const text = wrapCronPrompt(task);

  conversationRuntime.queueRuntime.enqueue({
    kind: "cron_prompt",
    source: "cron" as import("../types/protocol").QueueItemSource,
    text,
    cronTaskId: task.id,
    agentId: task.agent_id,
    conversationId: task.conversation_id,
  } as Omit<CronPromptQueueItem, "id" | "enqueuedAt">);

  scheduleQueuePump(conversationRuntime, socket, opts, processQueuedTurn);

  // Update task state
  const nowIso = now.toISOString();
  if (task.recurring) {
    updateTask(task.id, (t) => {
      t.last_fired_at = nowIso;
      t.fire_count += 1;
    });
  } else {
    // One-shot: mark as fired
    updateTask(task.id, (t) => {
      t.status = "fired";
      t.fired_at = nowIso;
      t.last_fired_at = nowIso;
      t.fire_count = 1;
    });
  }
}

function handleExpiredRecurring(task: CronTask, now: Date): void {
  if (!task.recurring || !task.expires_at) return;
  if (new Date(task.expires_at).getTime() <= now.getTime()) {
    updateTask(task.id, (t) => {
      t.status = "cancelled";
      t.cancel_reason = "expired";
    });
  }
}

/** Returns true if the task was marked as missed (caller should skip firing). */
function handleMissedOneShot(task: CronTask, now: Date): boolean {
  if (task.recurring || !task.scheduled_for) return false;
  // A one-shot is "missed" if it's been more than 5 minutes past scheduled time
  const scheduledMs = new Date(task.scheduled_for).getTime();
  const missThreshold = 5 * 60_000;
  if (now.getTime() > scheduledMs + missThreshold && task.status === "active") {
    updateTask(task.id, (t) => {
      t.status = "missed";
      t.missed_at = now.toISOString();
    });
    return true;
  }
  return false;
}

function tick(
  state: SchedulerState,
  socket: WebSocket,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  // Verify we still hold the lease
  if (!verifySchedulerLease(state.token)) {
    console.error("[Cron] Scheduler lease lost. Stopping.");
    stopScheduler();
    return;
  }

  const now = new Date();
  const currentMinuteKey = minuteKey(now);

  // Reset per-minute dedup when minute changes
  if (currentMinuteKey !== state.lastMinuteKey) {
    state.firedThisMinute.clear();
    state.lastMinuteKey = currentMinuteKey;
  }

  refreshTaskCache(state);

  for (const task of state.cachedTasks) {
    if (task.status !== "active") continue;

    // Handle expiry
    handleExpiredRecurring(task, now);
    if (task.status !== "active") continue;

    // Handle missed one-shots (skip firing if marked missed)
    if (handleMissedOneShot(task, now)) continue;

    // Per-minute dedup
    if (state.firedThisMinute.has(task.id)) continue;

    if (shouldFireTask(task, now)) {
      state.firedThisMinute.add(task.id);

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

        try {
          fireCronTask(freshTask, now, socket, opts, processQueuedTurn);
        } catch (err) {
          console.error(`[Cron] Error firing task ${taskId}:`, err);
        }
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
 */
export function startScheduler(
  socket: WebSocket,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): void {
  if (schedulerState) return;

  let token: string;
  try {
    token = claimSchedulerLease();
  } catch (err) {
    // Another process holds the lease — that's OK, don't start scheduler here
    console.error("[Cron] Could not claim scheduler lease:", err);
    return;
  }

  const now = new Date();
  const state: SchedulerState = {
    token,
    tickInterval: null as unknown as NodeJS.Timeout,
    gcInterval: null as unknown as NodeJS.Timeout,
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
