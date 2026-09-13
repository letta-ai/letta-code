import type {
  CronPauseCommand,
  CronResumeCommand,
  CronTriggerCommand,
} from "@/types/schedule-protocol";

export function isCronTriggerCommand(
  value: unknown,
): value is CronTriggerCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    command.type === "cron_trigger" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string"
  );
}

export function isCronPauseCommand(value: unknown): value is CronPauseCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
  };
  return (
    command.type === "cron_pause" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string"
  );
}

export function isCronResumeCommand(
  value: unknown,
): value is CronResumeCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as {
    type?: unknown;
    request_id?: unknown;
    task_id?: unknown;
    scheduled_for?: unknown;
  };
  return (
    command.type === "cron_resume" &&
    typeof command.request_id === "string" &&
    typeof command.task_id === "string" &&
    (command.scheduled_for === undefined ||
      typeof command.scheduled_for === "string")
  );
}
