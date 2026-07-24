import { isSupportedChannelId } from "@/channels/plugin-registry";
import type { CronChannelTarget } from "@/types/cron-channel-target";
import type {
  CronAddCommand,
  CronDeleteAllCommand,
  CronDeleteCommand,
  CronGetCommand,
  CronListCommand,
  CronRunsCommand,
  CronTriggerCommand,
  CronUpdateCommand,
} from "@/types/protocol_v2";

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isCronChannelTarget(value: unknown): value is CronChannelTarget {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.channel_id === "string" &&
    isSupportedChannelId(value.channel_id) &&
    (value.account_id === undefined || typeof value.account_id === "string") &&
    typeof value.chat_id === "string" &&
    value.chat_id.length > 0 &&
    (value.label === undefined || typeof value.label === "string")
  );
}

export function isCronChannelTargetArray(
  value: unknown,
): value is CronChannelTarget[] {
  return Array.isArray(value) && value.every(isCronChannelTarget);
}

export function isCronListCommand(value: unknown): value is CronListCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_list" &&
    typeof value.request_id === "string" &&
    (value.agent_id === undefined || typeof value.agent_id === "string") &&
    (value.conversation_id === undefined ||
      typeof value.conversation_id === "string")
  );
}

export function isCronAddCommand(value: unknown): value is CronAddCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_add" &&
    typeof value.request_id === "string" &&
    typeof value.agent_id === "string" &&
    (value.conversation_id === undefined ||
      typeof value.conversation_id === "string") &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.cron === "string" &&
    (value.timezone === undefined || typeof value.timezone === "string") &&
    typeof value.recurring === "boolean" &&
    typeof value.prompt === "string" &&
    (value.channel_targets === undefined ||
      isCronChannelTargetArray(value.channel_targets)) &&
    (value.scheduled_for === undefined ||
      value.scheduled_for === null ||
      typeof value.scheduled_for === "string")
  );
}

export function isCronGetCommand(value: unknown): value is CronGetCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_get" &&
    typeof value.request_id === "string" &&
    typeof value.task_id === "string"
  );
}

export function isCronRunsCommand(value: unknown): value is CronRunsCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_runs" &&
    typeof value.request_id === "string" &&
    typeof value.task_id === "string" &&
    (value.limit === undefined || typeof value.limit === "number") &&
    (value.offset === undefined || typeof value.offset === "number") &&
    (value.run_id === undefined || typeof value.run_id === "string")
  );
}

export function isCronTriggerCommand(
  value: unknown,
): value is CronTriggerCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_trigger" &&
    typeof value.request_id === "string" &&
    typeof value.task_id === "string"
  );
}

export function isCronUpdateCommand(
  value: unknown,
): value is CronUpdateCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_update" &&
    typeof value.request_id === "string" &&
    typeof value.task_id === "string" &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.description === undefined ||
      typeof value.description === "string") &&
    (value.conversation_id === undefined ||
      typeof value.conversation_id === "string") &&
    (value.channel_targets === undefined ||
      isCronChannelTargetArray(value.channel_targets)) &&
    (value.cron === undefined || typeof value.cron === "string") &&
    (value.timezone === undefined || typeof value.timezone === "string") &&
    (value.recurring === undefined || typeof value.recurring === "boolean") &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.scheduled_for === undefined ||
      value.scheduled_for === null ||
      typeof value.scheduled_for === "string")
  );
}

export function isCronDeleteCommand(
  value: unknown,
): value is CronDeleteCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_delete" &&
    typeof value.request_id === "string" &&
    typeof value.task_id === "string"
  );
}

export function isCronDeleteAllCommand(
  value: unknown,
): value is CronDeleteAllCommand {
  if (!isObjectRecord(value)) return false;
  return (
    value.type === "cron_delete_all" &&
    typeof value.request_id === "string" &&
    typeof value.agent_id === "string"
  );
}
