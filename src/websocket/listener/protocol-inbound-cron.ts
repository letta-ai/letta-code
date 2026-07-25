/**
 * Inbound type guards for the cron/schedule websocket commands.
 *
 * Command shapes live in @/types/protocol-cron; the aggregate inbound
 * dispatcher in protocol-inbound.ts composes these guards.
 */

import type {
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  CronRunsCommand,
  CronTriggerCommand,
  CronUpdateCommand,
} from "@/types/protocol-cron";

export function isCronListCommand(value: unknown): value is CronListCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
  };
  return (
    c.type === "cron_list" &&
    typeof c.request_id === "string" &&
    (c.agent_id === undefined || typeof c.agent_id === "string") &&
    (c.conversation_id === undefined || typeof c.conversation_id === "string")
  );
}

function isCronDeliveryInput(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!value || typeof value !== "object") return false;
  const d = value as {
    channel?: unknown;
    chat_id?: unknown;
    account_id?: unknown;
  };
  return (
    typeof d.channel === "string" &&
    typeof d.chat_id === "string" &&
    (d.account_id === undefined || typeof d.account_id === "string")
  );
}

export function isCronAddCommand(value: unknown): value is CronAddCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
    conversation_id?: unknown;
    name?: unknown;
    description?: unknown;
    cron?: unknown;
    timezone?: unknown;
    recurring?: unknown;
    prompt?: unknown;
    scheduled_for?: unknown;
    delivery?: unknown;
  };
  return (
    c.type === "cron_add" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string" &&
    (c.conversation_id === undefined ||
      typeof c.conversation_id === "string") &&
    typeof c.name === "string" &&
    typeof c.description === "string" &&
    typeof c.cron === "string" &&
    (c.timezone === undefined || typeof c.timezone === "string") &&
    typeof c.recurring === "boolean" &&
    typeof c.prompt === "string" &&
    (c.scheduled_for === undefined ||
      c.scheduled_for === null ||
      typeof c.scheduled_for === "string") &&
    isCronDeliveryInput(c.delivery)
  );
}

export function isCronGetCommand(value: unknown): value is CronGetCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    c.type === "cron_get" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string"
  );
}

export function isCronRunsCommand(value: unknown): value is CronRunsCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
    limit?: unknown;
    offset?: unknown;
    run_id?: unknown;
  };
  return (
    c.type === "cron_runs" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string" &&
    (c.limit === undefined || typeof c.limit === "number") &&
    (c.offset === undefined || typeof c.offset === "number") &&
    (c.run_id === undefined || typeof c.run_id === "string")
  );
}

export function isCronTriggerCommand(
  value: unknown,
): value is CronTriggerCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    c.type === "cron_trigger" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string"
  );
}

export function isCronUpdateCommand(
  value: unknown,
): value is CronUpdateCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
    name?: unknown;
    description?: unknown;
    conversation_id?: unknown;
    cron?: unknown;
    timezone?: unknown;
    recurring?: unknown;
    prompt?: unknown;
    scheduled_for?: unknown;
  };
  return (
    c.type === "cron_update" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string" &&
    (c.name === undefined || typeof c.name === "string") &&
    (c.description === undefined || typeof c.description === "string") &&
    (c.conversation_id === undefined ||
      typeof c.conversation_id === "string") &&
    (c.cron === undefined || typeof c.cron === "string") &&
    (c.timezone === undefined || typeof c.timezone === "string") &&
    (c.recurring === undefined || typeof c.recurring === "boolean") &&
    (c.prompt === undefined || typeof c.prompt === "string") &&
    (c.scheduled_for === undefined ||
      c.scheduled_for === null ||
      typeof c.scheduled_for === "string")
  );
}

export function isCronDeleteCommand(
  value: unknown,
): value is CronDeleteCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    c.type === "cron_delete" &&
    typeof c.request_id === "string" &&
    typeof c.task_id === "string"
  );
}

export function isCronDeleteAllCommand(
  value: unknown,
): value is CronDeleteAllCommand {
  if (!value || typeof value !== "object") return false;
  const c = value as {
    type?: unknown;
    request_id?: unknown;
    agent_id?: unknown;
  };
  return (
    c.type === "cron_delete_all" &&
    typeof c.request_id === "string" &&
    typeof c.agent_id === "string"
  );
}
