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

  // One-shot: check if scheduled_for is now or past
  if (!task.recurring && task.scheduled_for) {
    const scheduledMs =
      new Date(task.scheduled_for).getTime() + task.jitter_offset_ms;
    return scheduledMs <= now.getTime();
  }

  // Apply jitter offset: delay fire by jitter_offset_ms
  // For recurring tasks with late jitter (positive offset), check if the
  // adjusted time has passed within this minute window.
  const jitter = task.jitter_offset_ms;
  if (jitter > 0 && jitter < TICK_INTERVAL_MS) {
    // Cron must match the CURRENT minute (not a jitter-adjusted time)
    if (!cronMatchesTime(task.cron, now)) return false;
    // The jitter means "fire N ms after the minute boundary"
    // Since we tick once per minute, this fires on the matching minute.
    // The jitter is a sub-minute delay that the scheduler tolerates.
    return true;
  }

  return cronMatchesTime(task.cron, now);
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

  const conversationRuntime = getOrCreateConversationRuntime(
    listener,
    task.agent_id,
    task.conversation_id === "default" ? undefined : task.conversation_id,
  );

  if (!conversationRuntime) return;

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

function handleMissedOneShot(task: CronTask, now: Date): void {
  if (task.recurring || !task.scheduled_for) return;
  // A one-shot is "missed" if it's been more than 5 minutes past scheduled time
  const scheduledMs = new Date(task.scheduled_for).getTime();
  const missThreshold = 5 * 60_000;
  if (now.getTime() > scheduledMs + missThreshold && task.status === "active") {
    updateTask(task.id, (t) => {
      t.status = "missed";
      t.missed_at = now.toISOString();
    });
  }
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

    // Handle missed one-shots
    handleMissedOneShot(task, now);

    // Per-minute dedup
    if (state.firedThisMinute.has(task.id)) continue;

    if (shouldFireTask(task, now)) {
      state.firedThisMinute.add(task.id);
      try {
        fireCronTask(task, now, socket, opts, processQueuedTurn);
      } catch (err) {
        console.error(`[Cron] Error firing task ${task.id}:`, err);
        // Transient error — task stays active, will retry next tick
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
