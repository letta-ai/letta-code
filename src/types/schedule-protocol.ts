export type CronTaskStatus =
  | "active"
  | "paused"
  | "fired"
  | "missed"
  | "cancelled";
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
  | "invalid_cron"
  | "scheduler_error";

export interface CronListCommand {
  type: "cron_list";
  request_id: string;
  agent_id?: string;
  conversation_id?: string;
}

export interface CronAddCommand {
  type: "cron_add";
  request_id: string;
  agent_id: string;
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduled_for?: string | null;
}

export interface CronGetCommand {
  type: "cron_get";
  request_id: string;
  task_id: string;
}

export interface CronRunsCommand {
  type: "cron_runs";
  request_id: string;
  task_id: string;
  limit?: number;
  offset?: number;
  run_id?: string;
}

export interface CronTriggerCommand {
  type: "cron_trigger";
  request_id: string;
  task_id: string;
}

export interface CronPauseCommand {
  type: "cron_pause";
  request_id: string;
  task_id: string;
}

export interface CronResumeCommand {
  type: "cron_resume";
  request_id: string;
  task_id: string;
  /** Required when resuming an overdue one-off schedule. */
  scheduled_for?: string;
}

export interface CronUpdateCommand {
  type: "cron_update";
  request_id: string;
  task_id: string;
  name?: string;
  description?: string;
  conversation_id?: string;
  cron?: string;
  timezone?: string;
  recurring?: boolean;
  prompt?: string;
  scheduled_for?: string | null;
}

export interface CronDeleteCommand {
  type: "cron_delete";
  request_id: string;
  task_id: string;
}

export interface CronDeleteAllCommand {
  type: "cron_delete_all";
  request_id: string;
  agent_id: string;
}

export type CronProtocolCommand =
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronRunsCommand
  | CronTriggerCommand
  | CronPauseCommand
  | CronResumeCommand
  | CronUpdateCommand
  | CronDeleteCommand
  | CronDeleteAllCommand;

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

export interface CronListResponseMessage {
  type: "cron_list_response";
  request_id: string;
  tasks: CronTask[];
  success: boolean;
  error?: string;
}

export interface CronAddResponseMessage {
  type: "cron_add_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
  warning?: string;
  error?: string;
}

export interface CronGetResponseMessage {
  type: "cron_get_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task: CronTask | null;
  error?: string;
}

export interface CronRunsResponseMessage {
  type: "cron_runs_response";
  request_id: string;
  success: boolean;
  page?: CronRunLogPage;
  error?: string;
}

export interface CronTriggerResponseMessage {
  type: "cron_trigger_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronUpdateResponseMessage {
  type: "cron_update_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronPauseResponseMessage {
  type: "cron_pause_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronResumeResponseMessage {
  type: "cron_resume_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronDeleteResponseMessage {
  type: "cron_delete_response";
  request_id: string;
  success: boolean;
  found: boolean;
  error?: string;
}

export interface CronDeleteAllResponseMessage {
  type: "cron_delete_all_response";
  request_id: string;
  success: boolean;
  agent_id: string;
  deleted: number;
  error?: string;
}

export type CronProtocolResponseMessage =
  | CronListResponseMessage
  | CronAddResponseMessage
  | CronGetResponseMessage
  | CronRunsResponseMessage
  | CronTriggerResponseMessage
  | CronPauseResponseMessage
  | CronResumeResponseMessage
  | CronUpdateResponseMessage
  | CronDeleteResponseMessage
  | CronDeleteAllResponseMessage;

export type CronRunLogStatus = "ok" | "error" | "skipped";

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunLogStatus;
  outcome?: CronRunOutcome;
  reason?: CronRunReason;
  error?: string;
  summary?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  runAtMs?: number;
  queueItemId?: string;
  scheduledFor?: string | null;
  firedAt?: string;
}

export interface CronRunLogPage {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}
