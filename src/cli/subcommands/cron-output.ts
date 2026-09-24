import type { CloudSchedule } from "@/backend/api/schedules";
import { CLOUD_EXECUTION_TARGET } from "./cron-runner";

export function formatCloudScheduleOutput(
  schedule: CloudSchedule,
): Record<string, unknown> {
  const targetDeviceId = schedule.target_device_id ?? null;
  const messages = schedule.message?.messages;
  const first = Array.isArray(messages) ? messages[0] : undefined;
  return {
    id: schedule.id,
    runner: "cloud",
    execution_target: targetDeviceId ?? CLOUD_EXECUTION_TARGET,
    ...(targetDeviceId && { target_device_id: targetDeviceId }),
    agent_id: schedule.agent_id,
    conversation_id: schedule.conversation_id ?? "default",
    name: schedule.name ?? null,
    description: schedule.description ?? null,
    prompt: first && typeof first.content === "string" ? first.content : null,
    schedule: schedule.schedule,
    recurring: schedule.schedule.type === "recurring",
    next_scheduled_time: schedule.next_scheduled_time,
    created_at: schedule.created_at ?? null,
  };
}
