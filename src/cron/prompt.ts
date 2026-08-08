import type { CronTask } from "./cron-file";
import { formatScheduledTaskPrompt } from "./scheduled-task-prompt";

export {
  formatScheduledTaskPrompt,
  formatTimezoneQualifiedIso,
  parseScheduledTaskPrompt,
  type ScheduledTaskPromptInfo,
  type ScheduledTaskPromptInput,
  type ScheduledTaskRecurrence,
} from "./scheduled-task-prompt";

export interface CronPromptTiming {
  /** The schedule occurrence that caused this turn to fire. */
  intendedOccurrence: Date;
  /** Authoritative time captured by the scheduler when the turn is enqueued. */
  schedulerNow: Date;
}

export function getIntendedCronOccurrence(
  task: Pick<CronTask, "recurring" | "scheduled_for">,
  matchedAt: Date,
): Date {
  if (!task.recurring && task.scheduled_for) {
    const scheduledFor = new Date(task.scheduled_for);
    if (Number.isFinite(scheduledFor.getTime())) {
      return scheduledFor;
    }
  }

  const occurrence = new Date(matchedAt);
  occurrence.setSeconds(0, 0);
  return occurrence;
}

export function formatCronPrompt(
  task: CronTask,
  timing: CronPromptTiming,
): string {
  return formatScheduledTaskPrompt({
    name: task.name,
    description: task.description,
    timezone: typeof task.timezone === "string" ? task.timezone : "",
    scheduledFor: timing.intendedOccurrence,
    currentTime: timing.schedulerNow,
    recurrence: task.recurring
      ? {
          type: "recurring",
          cron: task.cron,
          fireNumber: task.fire_count + 1,
        }
      : { type: "one-off" },
    prompt: task.prompt,
  });
}
