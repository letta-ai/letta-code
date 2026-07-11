export type CronTaskStatus = "active" | "fired" | "missed" | "cancelled";
export type CronCancelReason = "conversation_not_found" | "expired";
export type CronRunOutcome = "queued" | "missed" | "failed" | "skipped";
export type CronRunReason =
  | "scheduled_time_matched"
  | "one_off_due"
  | "scheduler_inactive"
  | "started_too_late"
  | "queue_full"
  | "runtime_unavailable"
  | "task_cancelled"
  | "scheduler_error";

export interface CronTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: CronTaskStatus;
  created_at: string;
  expires_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: CronCancelReason | null;
  jitter_offset_ms: number;
  last_run_at: string | null;
  last_run_outcome: CronRunOutcome | null;
  last_run_reason: CronRunReason | null;
  last_run_error: string | null;
  last_missed_at: string | null;
  missed_count: number;
  failed_count: number;
  scheduled_for: string | null;
  fired_at: string | null;
  missed_at: string | null;
}

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

export interface CronRunLogPage {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}
