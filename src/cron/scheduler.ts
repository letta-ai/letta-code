import { isLocalAgentId } from "@/agent/agent-id";
import { getBackend } from "@/backend";
import type { ConversationCreateBody } from "@/backend/backend";
import type { CronPromptQueueItem, DequeuedBatch } from "@/queue/queue-runtime";
import { debugWarn } from "@/utils/debug";
import { TO_SUBSCRIBERS } from "@/websocket/listener/connection";
import { ensureConversationQueueRuntime } from "@/websocket/listener/conversation-runtime";
import { emitProtocolV2Message } from "@/websocket/listener/protocol-outbound";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import {
  getActiveRuntime,
  getConversationRuntimeKey,
  getOrCreateConversationRuntime,
  isSidebandOnlyScope,
} from "@/websocket/listener/runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type {
  IncomingMessage,
  StartListenerOptions,
} from "@/websocket/listener/types";
import {
  type CronRunOutcome,
  type CronRunReason,
  type CronSchedulerScope,
  type CronTask,
  claimSchedulerLease,
  garbageCollect,
  getActiveTasks,
  getCronFileMtime,
  getTask,
  readCronFile,
  recordTaskQueued,
  refreshSchedulerLease,
  releaseSchedulerLease,
  updateTask,
} from "./cron-file";
import { cronMatchesTime, isValidCron } from "./parse-interval";
import {
  type CronPromptTiming,
  formatCronPrompt,
  getIntendedCronOccurrence,
} from "./prompt";
import { safeAppendCronRunLogForTask } from "./run-log";
import { getLocalCronExecutionError } from "./runner";
import { SCHEDULE_ORIGIN_TAG } from "./scheduled-task-prompt";

export {
  type CronPromptTiming,
  formatCronPrompt,
  formatTimezoneQualifiedIso,
  getIntendedCronOccurrence,
} from "./prompt";

type ProcessQueuedTurn = (
  queuedTurn: IncomingMessage,
  dequeuedBatch: DequeuedBatch,
) => Promise<void>;

interface SchedulerState {
  token: string;
  scope: CronSchedulerScope;
  tickInterval: NodeJS.Timeout;
  gcInterval: NodeJS.Timeout;
  socket: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
  lastMtime: number;
  cachedTasks: CronTask[];
  firedThisMinute: Set<string>;
  lastMinuteKey: string;
  pendingTimers: Set<NodeJS.Timeout>;
  tombstoneToken: string | undefined;
  tombstoneInterval: NodeJS.Timeout | null;
}

let schedulerState: SchedulerState | null = null;

export const CRON_SCHEDULER_SCOPE_ENV = "LETTA_CRON_SCHEDULER_SCOPE";

export function resolveCronSchedulerScope(
  value = process.env[CRON_SCHEDULER_SCOPE_ENV],
): CronSchedulerScope {
  return value === "cloud" || value === "local" ? value : "all";
}

export function taskMatchesCronSchedulerScope(
  task: CronTask,
  scope: CronSchedulerScope,
): boolean {
  if (scope === "all") return true;
  return scope === "local"
    ? isLocalAgentId(task.agent_id)
    : !isLocalAgentId(task.agent_id);
}

let listenerFireContext: {
  socket: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
} | null = null;

const TICK_INTERVAL_MS = 60_000;
const GC_INTERVAL_MS = 60 * 60_000;
const TOMBSTONE_HEARTBEAT_MS = 1_000;
const LEASE_RETRY_MS = 30_000;
const MAX_LEASE_RETRIES = 3;
const SLOW_LEASE_RETRY_MS = 5 * 60_000;

let slowLeaseRetryTimer: ReturnType<typeof setInterval> | null = null;

function clearSlowLeaseRetry(): void {
  if (slowLeaseRetryTimer) clearInterval(slowLeaseRetryTimer);
  slowLeaseRetryTimer = null;
}
const NEW_CONVERSATION_TARGET = "new";

function logScheduler(opts: StartListenerOptions, message: string): void {
  if (opts.onLog) {
    opts.onLog(`[Cron] ${message}`);
    return;
  }
  debugWarn("Cron", message);
}

function holdSchedulerLease(
  state: SchedulerState,
  opts: StartListenerOptions,
): boolean {
  if (refreshSchedulerLease(state.token, state.scope, state.tombstoneToken)) {
    return true;
  }
  if (state.scope === "all") {
    logScheduler(opts, "Scheduler lease lost. Stopping.");
    stopScheduler();
    return false;
  }
  try {
    state.token = claimSchedulerLease(state.scope);
    state.tombstoneToken = readCronFile().scheduler_owner?.token;
    logScheduler(opts, "Reclaimed scoped scheduler lease.");
    return true;
  } catch (err) {
    logScheduler(
      opts,
      `Scheduler lease lost; retrying: ${err instanceof Error ? err.message : String(err)}`,
    );
    clearPendingFireTimers(state);
    return false;
  }
}

function clearPendingFireTimers(state: SchedulerState): void {
  for (const handle of state.pendingTimers) {
    clearTimeout(handle);
  }
  state.pendingTimers.clear();
}

export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function wrapCronPrompt(
  task: CronTask,
  timing: CronPromptTiming,
): string {
  return formatCronPrompt(task, timing);
}

async function resolveCronFireConversationId(
  task: CronTask,
): Promise<string | undefined> {
  if (task.conversation_id === NEW_CONVERSATION_TARGET) {
    const conversation = await getBackend().createConversation({
      agent_id: task.agent_id,
      summary: task.name,
      tags: [SCHEDULE_ORIGIN_TAG],
    } as ConversationCreateBody);
    return conversation.id;
  }

  return task.conversation_id === "default" ? undefined : task.conversation_id;
}

function emitCronsUpdated(
  socket: ListenerTransport,
  task: CronTask,
  conversationId?: string | null,
): void {
  const listener = getActiveRuntime();
  if (!listener) return;
  const runtimeScope = {
    agent_id: task.agent_id,
    conversation_id: conversationId ?? task.conversation_id ?? "default",
  };
  const payload = {
    type: "crons_updated" as const,
    timestamp: Date.now(),
    agent_id: task.agent_id,
    conversation_id: runtimeScope.conversation_id,
  };
  emitProtocolV2Message(
    socket,
    listener,
    payload,
    runtimeScope,
    TO_SUBSCRIBERS,
  );
}

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
  if (!task.recurring && task.scheduled_for) {
    const scheduledMs =
      new Date(task.scheduled_for).getTime() + task.jitter_offset_ms;
    return scheduledMs <= now.getTime();
  }

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
  trigger: "automatic" | "manual",
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

  if (
    isSidebandOnlyScope(
      listener,
      getConversationRuntimeKey(task.agent_id, targetConversationId),
    )
  ) {
    setLastRunOutcome(task.id, {
      outcome: "failed",
      reason: "runtime_unavailable",
      runAt: timing.schedulerNow,
      error: "Conversation is only held for remote worker control",
    });
    safeAppendCronRunLogForTask(task, {
      status: "error",
      outcome: "failed",
      reason: "runtime_unavailable",
      error: "Conversation is only held for remote worker control",
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
  const conversationRuntime = ensureConversationQueueRuntime(
    listener,
    rawRuntime,
  );

  if (trigger === "automatic" && getTask(task.id)?.status !== "active") {
    return false;
  }

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

  const nowIso = timing.schedulerNow.toISOString();
  recordTaskQueued(task.id, trigger, timing.schedulerNow);

  const runReason = task.recurring ? "scheduled_time_matched" : "one_off_due";
  safeAppendCronRunLogForTask(task, {
    status: "ok",
    outcome: "queued",
    reason: runReason,
    runAtMs: timing.schedulerNow.getTime(),
    queueItemId: queuedItem.id,
    scheduledFor: task.scheduled_for,
    firedAt: nowIso,
    conversationId: targetConversationId ?? "default",
  });
  emitCronsUpdated(socket, task, targetConversationId ?? "default");
  return true;
}

export function handleMissedOneShot(task: CronTask, now: Date): boolean {
  if (task.recurring || !task.scheduled_for) return false;
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
  const executionError = getLocalCronExecutionError();
  if (executionError) {
    return {
      success: false,
      found: false,
      error: executionError,
    };
  }

  const task = getTask(taskId);
  if (!task) {
    return { success: false, found: false, error: "Schedule not found" };
  }

  if (task.status !== "active" && task.status !== "paused") {
    return {
      success: false,
      found: true,
      task,
      error: "Completed schedules cannot run again",
    };
  }

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
    "manual",
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
  if (!holdSchedulerLease(state, opts)) {
    return;
  }

  const matchedAt = new Date();
  const currentMinuteKey = minuteKey(matchedAt);

  if (currentMinuteKey !== state.lastMinuteKey) {
    state.firedThisMinute.clear();
    state.lastMinuteKey = currentMinuteKey;
  }

  refreshTaskCache(state);

  for (const task of state.cachedTasks) {
    if (task.status !== "active") continue;
    if (!taskMatchesCronSchedulerScope(task, state.scope)) continue;

    const invalidCronWasReported = hasReportedInvalidCron(task);
    const invalidCron = task.recurring && !isValidCron(task.cron);
    if (handleTaskPreflight(task, matchedAt)) {
      if (invalidCron && !invalidCronWasReported) {
        emitCronsUpdated(socket, task);
      }
      continue;
    }

    if (state.firedThisMinute.has(task.id)) continue;

    if (shouldFireTask(task, matchedAt)) {
      state.firedThisMinute.add(task.id);
      const intendedOccurrence = getIntendedCronOccurrence(task, matchedAt);

      const jitterMs = task.recurring ? task.jitter_offset_ms : 0;
      const taskId = task.id;
      const doFire = () => {
        if (!schedulerState) return;
        try {
          if (
            !refreshSchedulerLease(
              schedulerState.token,
              schedulerState.scope,
              schedulerState.tombstoneToken,
            )
          ) {
            return;
          }
        } catch (err) {
          logScheduler(
            opts,
            `Jitter fire lease check error: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        const freshTask = getTask(taskId);
        if (!freshTask || freshTask.status !== "active") return;

        const schedulerNow = new Date();
        void fireCronTask(
          freshTask,
          { intendedOccurrence, schedulerNow },
          socket,
          opts,
          processQueuedTurn,
          "automatic",
        ).catch((err) => {
          logScheduler(
            opts,
            `Error firing task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
          );
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

export function startScheduler(
  socket: ListenerTransport,
  opts: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
  _retryCount = 0,
): void {
  if (getLocalCronExecutionError()) {
    return;
  }

  listenerFireContext = { socket, opts, processQueuedTurn };

  if (schedulerState) return;

  let token: string;
  const scope = resolveCronSchedulerScope();
  try {
    token = claimSchedulerLease(scope);
  } catch (err) {
    if (slowLeaseRetryTimer) return;
    if (_retryCount < MAX_LEASE_RETRIES) {
      logScheduler(
        opts,
        `Could not claim scheduler lease (attempt ${_retryCount + 1}/${MAX_LEASE_RETRIES + 1}): ${err instanceof Error ? err.message : err}`,
      );
      logScheduler(
        opts,
        "Cron tasks will not fire until the scheduler starts. Retrying...",
      );
      setTimeout(
        () => startScheduler(socket, opts, processQueuedTurn, _retryCount + 1),
        LEASE_RETRY_MS,
      );
    } else {
      logScheduler(
        opts,
        `Failed to claim scheduler lease after ${MAX_LEASE_RETRIES + 1} attempts. Cron tasks will not fire.`,
      );
      logScheduler(
        opts,
        `Another process may hold the lease. Retrying every ${SLOW_LEASE_RETRY_MS / 60_000} minutes.`,
      );
      slowLeaseRetryTimer = setInterval(() => {
        const ctx = listenerFireContext;
        if (!ctx || schedulerState) {
          clearSlowLeaseRetry();
          return;
        }
        startScheduler(
          ctx.socket,
          ctx.opts,
          ctx.processQueuedTurn,
          _retryCount,
        );
      }, SLOW_LEASE_RETRY_MS);
      slowLeaseRetryTimer.unref?.();
    }
    return;
  }

  if (slowLeaseRetryTimer) {
    clearSlowLeaseRetry();
    logScheduler(opts, "Claimed scheduler lease on slow retry.");
  }

  const now = new Date();
  const state: SchedulerState = {
    token,
    scope,
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
    tombstoneToken: readCronFile().scheduler_owner?.token,
    tombstoneInterval: null,
  };

  schedulerState = state;

  tick(state, socket, opts, processQueuedTurn);
  if (schedulerState !== state) {
    return;
  }

  state.tickInterval = setInterval(() => {
    tick(state, socket, opts, processQueuedTurn);
  }, TICK_INTERVAL_MS);

  state.gcInterval = setInterval(() => {
    try {
      const removed = garbageCollect();
      if (removed > 0) {
        state.lastMtime = 0;
      }
    } catch (err) {
      logScheduler(
        opts,
        `GC error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, GC_INTERVAL_MS);

  if (scope !== "all") {
    state.tombstoneInterval = setInterval(() => {
      try {
        holdSchedulerLease(state, opts);
      } catch (err) {
        logScheduler(
          opts,
          `Tombstone heartbeat error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }, TOMBSTONE_HEARTBEAT_MS);
  }
}

export function stopScheduler(): void {
  listenerFireContext = null;
  clearSlowLeaseRetry();
  if (!schedulerState) return;

  clearInterval(schedulerState.tickInterval);
  clearInterval(schedulerState.gcInterval);
  if (schedulerState.tombstoneInterval) {
    clearInterval(schedulerState.tombstoneInterval);
  }

  clearPendingFireTimers(schedulerState);

  try {
    releaseSchedulerLease(schedulerState.token, schedulerState.scope);
  } catch {}

  schedulerState = null;
}

export function isSchedulerRunning(): boolean {
  return schedulerState !== null;
}
