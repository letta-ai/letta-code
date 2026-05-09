import {
  SYSTEM_ALERT_CLOSE,
  SYSTEM_ALERT_OPEN,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";

export function stripSystemReminders(text: string): string {
  return text
    .replace(
      new RegExp(
        `${SYSTEM_REMINDER_OPEN}[\\s\\S]*?${SYSTEM_REMINDER_CLOSE}`,
        "g",
      ),
      "",
    )
    .replace(
      new RegExp(`${SYSTEM_ALERT_OPEN}[\\s\\S]*?${SYSTEM_ALERT_CLOSE}`, "g"),
      "",
    )
    .trim();
}
