export type ScheduledTaskRecurrence =
  | { type: "one-off" }
  | { type: "recurring"; cron: string; fireNumber?: number };

/**
 * Conversation tag marking a conversation created by a scheduled task fire.
 *
 * Every schedule runner stamps this when it creates a conversation, so clients
 * can identify scheduled conversations without parsing the summary text.
 */
export const SCHEDULE_ORIGIN_TAG = "origin:schedule";

export interface ScheduledTaskPromptInput {
  name: string;
  description?: string | null;
  timezone: string;
  scheduledFor: Date;
  currentTime: Date;
  recurrence: ScheduledTaskRecurrence;
  prompt: string;
}

export interface ScheduledTaskPromptInfo {
  name: string;
  description: string | null;
  timezone: string | null;
  scheduledFor: string | null;
  recurrence: ScheduledTaskRecurrence;
  prompt: string;
}

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const AUTONOMOUS_NOTICE_PREFIX = "You are running autonomously:";
const AUTONOMOUS_NOTICE =
  "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.";

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

function formatRecurrence(recurrence: ScheduledTaskRecurrence): string {
  if (recurrence.type === "one-off") {
    return "This is a one-off scheduled task.";
  }
  if (recurrence.fireNumber !== undefined) {
    return `This is fire #${recurrence.fireNumber} (cron: ${recurrence.cron}).`;
  }
  return `This is a recurring scheduled task (cron: ${recurrence.cron}).`;
}

/**
 * Build the canonical prompt envelope for a scheduled agent turn.
 *
 * Every schedule runner should call this immediately before dispatch while
 * keeping its stored authored prompt separate from runtime metadata.
 */
export function formatScheduledTaskPrompt(
  input: ScheduledTaskPromptInput,
): string {
  const lines = [
    `Scheduled task "${input.name}" is firing.`,
    ...(input.description ? [`Description: ${input.description}`] : []),
    `Timezone: ${formatTimezoneDisplay(input.timezone)}`,
    `Scheduled for: ${formatTimezoneQualifiedIso(input.scheduledFor, input.timezone)}`,
    `Current time: ${formatTimezoneQualifiedIso(input.currentTime, input.timezone)}`,
    formatRecurrence(input.recurrence),
    "",
    AUTONOMOUS_NOTICE,
    "",
    `Prompt: ${input.prompt}`,
  ];
  return lines.join("\n");
}

function unwrapSystemReminder(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.startsWith(SYSTEM_REMINDER_OPEN) &&
    trimmed.endsWith(SYSTEM_REMINDER_CLOSE)
  ) {
    return trimmed
      .slice(SYSTEM_REMINDER_OPEN.length, -SYSTEM_REMINDER_CLOSE.length)
      .trim();
  }
  return trimmed;
}

function getField(lines: string[], prefix: string): string | null {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value || null;
}

function getPrompt(text: string, recurrenceLineIndex: number): string | null {
  const promptMarker = "\nPrompt: ";
  const promptIndex = text.indexOf(promptMarker);
  if (promptIndex >= 0) {
    return text.slice(promptIndex + promptMarker.length).trim() || null;
  }

  const trailingLines = text.split("\n").slice(recurrenceLineIndex + 1);
  while (trailingLines[0]?.trim() === "") trailingLines.shift();
  if (trailingLines[0]?.startsWith(AUTONOMOUS_NOTICE_PREFIX)) {
    trailingLines.shift();
    while (trailingLines[0]?.trim() === "") trailingLines.shift();
  }
  return trailingLines.join("\n").trim() || null;
}

/** Parse canonical and legacy scheduled-task envelopes from persisted messages. */
export function parseScheduledTaskPrompt(
  rawText: string,
): ScheduledTaskPromptInfo | null {
  const text = unwrapSystemReminder(rawText).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const titleMatch = /^Scheduled task ["“](.+)["”] is firing\.$/.exec(
    lines[0]?.trim() ?? "",
  );
  if (!titleMatch?.[1]) return null;

  const recurrenceLineIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      trimmed === "This is a one-off scheduled task." ||
      /^This is fire #\d+ \(cron: .+\)\.$/.test(trimmed) ||
      /^This is a recurring scheduled task \(cron: .+\)\.$/.test(trimmed)
    );
  });
  if (recurrenceLineIndex < 0) return null;

  const recurrenceLine = lines[recurrenceLineIndex]?.trim() ?? "";
  const countedRecurringMatch = /^This is fire #(\d+) \(cron: (.+)\)\.$/.exec(
    recurrenceLine,
  );
  const recurringMatch =
    /^This is a recurring scheduled task \(cron: (.+)\)\.$/.exec(
      recurrenceLine,
    );
  let recurrence: ScheduledTaskRecurrence;
  if (countedRecurringMatch) {
    recurrence = {
      type: "recurring",
      fireNumber: Number.parseInt(countedRecurringMatch[1] ?? "0", 10),
      cron: countedRecurringMatch[2] ?? "",
    };
  } else if (recurringMatch) {
    recurrence = { type: "recurring", cron: recurringMatch[1] ?? "" };
  } else {
    recurrence = { type: "one-off" };
  }

  const prompt = getPrompt(text, recurrenceLineIndex);
  if (!prompt) return null;

  return {
    name: titleMatch[1],
    description: getField(lines, "Description:"),
    timezone: getField(lines, "Timezone:"),
    scheduledFor: getField(lines, "Scheduled for:"),
    recurrence,
    prompt,
  };
}
