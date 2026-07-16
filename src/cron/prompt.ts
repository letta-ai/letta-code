import type { CronTask } from "./cron-file";

export interface CronPromptTiming {
  /** The schedule occurrence that caused this turn to fire. */
  intendedOccurrence: Date;
  /** Authoritative time captured by the scheduler when the turn is enqueued. */
  schedulerNow: Date;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
}

function getLocalDateTimeParts(date: Date): ZonedDateTimeParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function getSystemTimezone(): string | null {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone || !isValidTimezone(timezone)) {
    return null;
  }
  return timezone;
}

function getEffectiveTimezone(timezone: string): string | null {
  const trimmed = timezone.trim();
  if (trimmed && isValidTimezone(trimmed)) {
    return trimmed;
  }
  return getSystemTimezone();
}

function formatTimezoneDisplay(timezone: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) {
    return "local time";
  }
  if (isValidTimezone(trimmed)) {
    return trimmed;
  }
  return `${trimmed} (invalid; using local time)`;
}

function getZonedDateTimeParts(
  date: Date,
  timezone: string,
): ZonedDateTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = new Map(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );

  return {
    year: Number.parseInt(parts.get("year") ?? "0", 10),
    month: Number.parseInt(parts.get("month") ?? "1", 10),
    day: Number.parseInt(parts.get("day") ?? "1", 10),
    hour: Number.parseInt(parts.get("hour") ?? "0", 10),
    minute: Number.parseInt(parts.get("minute") ?? "0", 10),
    second: Number.parseInt(parts.get("second") ?? "0", 10),
  };
}

export function formatTimezoneQualifiedIso(
  date: Date,
  timezone: string,
): string {
  const effectiveTimezone = getEffectiveTimezone(timezone);
  const parts = effectiveTimezone
    ? getZonedDateTimeParts(date, effectiveTimezone)
    : getLocalDateTimeParts(date);
  const millis = date.getMilliseconds();
  const zonedAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    millis,
  );
  const offsetMinutes = Math.round((zonedAsUtcMs - date.getTime()) / 60_000);

  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}T${pad(parts.hour, 2)}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}.${pad(millis, 3)}${formatOffset(offsetMinutes)}[${effectiveTimezone ?? "local"}]`;
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
  const timezone = typeof task.timezone === "string" ? task.timezone : "";
  const lines = [
    `Scheduled task "${task.name}" is firing.`,
    `Description: ${task.description}`,
    `Timezone: ${formatTimezoneDisplay(timezone)}`,
    `Scheduled for: ${formatTimezoneQualifiedIso(timing.intendedOccurrence, timezone)}`,
    `Current time: ${formatTimezoneQualifiedIso(timing.schedulerNow, timezone)}`,
    task.recurring
      ? `This is fire #${task.fire_count + 1} (cron: ${task.cron}).`
      : "This is a one-off scheduled task.",
    "",
    "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.",
    "",
    `Prompt: ${task.prompt}`,
  ];
  return lines.join("\n");
}
