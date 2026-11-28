import { SYSTEM_ALERT_CLOSE, SYSTEM_ALERT_OPEN } from "@/constants";
import {
  scheduledTaskPromptDisplayText,
  stripNonScheduledSystemReminders,
} from "@/cron/scheduled-task-prompt";

export function stripSystemReminders(text: string): string {
  const scheduled = scheduledTaskPromptDisplayText(text);
  if (scheduled !== null) return scheduled;
  return stripNonScheduledSystemReminders(text)
    .replace(
      new RegExp(`${SYSTEM_ALERT_OPEN}[\\s\\S]*?${SYSTEM_ALERT_CLOSE}`, "g"),
      "",
    )
    .trim();
}
