/**
 * Cron/schedule websocket commands (protocol V2).
 *
 * Request shapes for the `cron_*` listener commands. Response message
 * shapes live in protocol_v2.ts with the rest of the outbound surface.
 */

export interface CronListCommand {
  type: "cron_list";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Optional agent filter. */
  agent_id?: string;
  /** Optional conversation filter. */
  conversation_id?: string;
}

export interface CronAddCommand {
  type: "cron_add";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
  /**
   * Conversation target for scheduled fires.
   * - omitted/"default": agent default conversation
   * - "new": create a fresh conversation for every fire
   * - any other string: existing conversation id
   */
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  /** Optional ISO timestamp for one-shot tasks. */
  scheduled_for?: string | null;
  /**
   * Optional outbound channel delivery target for scheduled runs.
   * Validated against the agent's routes when the task is added.
   */
  delivery?: {
    channel: string;
    chat_id: string;
    account_id?: string;
  } | null;
}

export interface CronGetCommand {
  type: "cron_get";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronRunsCommand {
  type: "cron_runs";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
  /** Maximum run-log entries to return. */
  limit?: number;
  /** Page offset for run-log entries. */
  offset?: number;
  /** Optional run id filter. */
  run_id?: string;
}

export interface CronTriggerCommand {
  type: "cron_trigger";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronUpdateCommand {
  type: "cron_update";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
  name?: string;
  description?: string;
  conversation_id?: string;
  cron?: string;
  timezone?: string;
  recurring?: boolean;
  prompt?: string;
  /** Optional ISO timestamp for one-shot tasks. */
  scheduled_for?: string | null;
}

export interface CronDeleteCommand {
  type: "cron_delete";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronDeleteAllCommand {
  type: "cron_delete_all";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
}
