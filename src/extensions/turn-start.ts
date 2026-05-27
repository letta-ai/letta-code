import type { ExtensionEventEmissionResult } from "@/extensions/types";

export function collectTurnStartSystemReminders(
  result: ExtensionEventEmissionResult<"turn_start">,
): string[] {
  const reminders: string[] = [];
  for (const effect of result.results) {
    const reminder = effect.input?.appendSystemReminder;
    if (typeof reminder === "string" && reminder.trim().length > 0) {
      reminders.push(reminder);
    }
  }
  return reminders;
}
