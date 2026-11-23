import { CronExpressionParser } from "cron-parser";

export interface ParsedInterval {
  cron: string;
  note?: string;
}

const INTERVAL_RE =
  /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/i;

export function parseEvery(input: string): ParsedInterval | null {
  const match = input.trim().match(INTERVAL_RE);
  if (!match) return null;

  const value = Number.parseInt(match[1] ?? "", 10);
  if (value <= 0 || !Number.isFinite(value)) return null;

  const unit = (match[2] ?? "").toLowerCase();

  if (unit.startsWith("s")) {
    if (value < 60) {
      return {
        cron: "*/1 * * * *",
        note: `Rounded ${value}s up to 1m (minimum granularity is 1 minute)`,
      };
    }
    const mins = Math.round(value / 60);
    return minuteCron(mins);
  }

  if (unit.startsWith("m")) {
    return minuteCron(value);
  }

  if (unit.startsWith("h")) {
    if (value >= 24) {
      return { cron: "0 0 * * *", note: `${value}h clamped to daily` };
    }
    if (24 % value === 0) {
      return { cron: `0 */${value} * * *` };
    }
    const divisors = [1, 2, 3, 4, 6, 8, 12, 24];
    const closest = divisors.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
    );
    return {
      cron: `0 */${closest} * * *`,
      note: `${value}h rounded to every ${closest}h (nearest clean divisor of 24)`,
    };
  }

  if (unit.startsWith("d")) {
    if (value === 1) {
      return { cron: "0 0 * * *" };
    }
    const cron = `0 0 */${value} * *`;
    return isValidCron(cron) ? { cron } : null;
  }

  return null;
}

function minuteCron(mins: number): ParsedInterval {
  if (mins <= 0) return { cron: "*/1 * * * *", note: "Rounded to 1m minimum" };
  if (mins >= 60) {
    const hours = Math.round(mins / 60);
    return { cron: `0 */${Math.max(1, hours)} * * *` };
  }

  if (60 % mins === 0) {
    return { cron: `*/${mins} * * * *` };
  }

  const divisors = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const closest = divisors.reduce((prev, curr) =>
    Math.abs(curr - mins) < Math.abs(prev - mins) ? curr : prev,
  );
  return {
    cron: `*/${closest} * * * *`,
    note: `${mins}m rounded to every ${closest}m (nearest clean divisor of 60)`,
  };
}

export interface ParsedAt {
  scheduledFor: Date;
  cron: string;
  note?: string;
}

const TIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;
const RELATIVE_RE = /^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i;
const RFC3339_WITH_ZONE_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseRfc3339Timestamp(input: string): Date | null {
  const trimmed = input.trim();
  const match = trimmed.match(RFC3339_WITH_ZONE_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseAt(input: string, now?: Date): ParsedAt | null {
  const trimmed = input.trim();
  const currentTime = now ?? new Date();

  const relMatch = trimmed.match(RELATIVE_RE);
  if (relMatch) {
    const value = Number.parseInt(relMatch[1] ?? "", 10);
    const unit = (relMatch[2] ?? "").toLowerCase();
    let ms: number;
    if (unit.startsWith("h")) {
      ms = value * 60 * 60 * 1000;
    } else {
      ms = value * 60 * 1000;
    }
    const scheduledFor = new Date(currentTime.getTime() + ms);
    return {
      scheduledFor,
      cron: dateToCron(scheduledFor),
      note: `Scheduled for ${scheduledFor.toLocaleTimeString()} (in ${value}${unit.charAt(0)})`,
    };
  }

  const explicitTime = parseRfc3339Timestamp(trimmed);
  if (explicitTime) {
    if (explicitTime.getTime() <= currentTime.getTime()) return null;
    return {
      scheduledFor: explicitTime,
      cron: dateToCron(explicitTime),
      note: `Scheduled for ${explicitTime.toISOString()}`,
    };
  }

  const timeMatch = trimmed.match(TIME_RE);
  if (timeMatch) {
    let hours = Number.parseInt(timeMatch[1] ?? "", 10);
    const minutes = Number.parseInt(timeMatch[2] ?? "", 10);
    const ampm = (timeMatch[3] ?? "").toLowerCase();

    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) return null;

    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const scheduledFor = new Date(currentTime);
    scheduledFor.setHours(hours, minutes, 0, 0);

    if (scheduledFor.getTime() <= currentTime.getTime()) {
      scheduledFor.setDate(scheduledFor.getDate() + 1);
    }

    return {
      scheduledFor,
      cron: dateToCron(scheduledFor),
    };
  }

  return null;
}

function dateToCron(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

const SUPPORTED_CRON_RE = /^[\d\s*,*/-]+$/;

function hasBareValueStep(fields: string[]): boolean {
  return fields.some((field) =>
    field.split(",").some((part) => /^\d+\/\d+$/.test(part)),
  );
}

type OneBasedCronField = "dayOfMonth" | "month";

function normalizeOneBasedWildcardSteps(
  field: string,
  min: number,
  max: number,
  fieldName: OneBasedCronField,
): string | null {
  const parts = field.split(",");
  if (!parts.some((part) => /^\*\/\d+$/.test(part))) return field;

  const normalizedValues = new Set<number>();
  for (const part of parts) {
    const wildcardStep = part.match(/^\*\/(\d+)$/);
    if (wildcardStep) {
      const step = Number.parseInt(wildcardStep[1] ?? "", 10);
      for (let value = min; value <= max; value++) {
        if (value % step === 0) normalizedValues.add(value);
      }
      continue;
    }

    const expression =
      fieldName === "dayOfMonth" ? `0 0 ${part} * *` : `0 0 * ${part} *`;
    const parsed = CronExpressionParser.parse(expression, { strict: false });
    for (const value of parsed.fields[fieldName].values) {
      if (typeof value === "number") normalizedValues.add(value);
    }
  }
  return normalizedValues.size > 0
    ? [...normalizedValues].sort((a, b) => a - b).join(",")
    : null;
}

function normalizeCronExpressionForParser(expr: string): string | null {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;
  if (!SUPPORTED_CRON_RE.test(trimmed)) return null;
  if (hasBareValueStep(fields)) return null;
  const hasOneBasedWildcardStep = fields
    .slice(2, 4)
    .some((field) => field.split(",").some((part) => /^\*\/\d+$/.test(part)));
  if (hasOneBasedWildcardStep) {
    try {
      CronExpressionParser.parse(trimmed, { strict: false });
    } catch {
      return null;
    }
  }

  const normalizedFields: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    if (index === 2) {
      const normalized = normalizeOneBasedWildcardSteps(
        field,
        1,
        31,
        "dayOfMonth",
      );
      if (normalized === null) return null;
      normalizedFields.push(normalized);
      continue;
    }
    if (index === 3) {
      const normalized = normalizeOneBasedWildcardSteps(field, 1, 12, "month");
      if (normalized === null) return null;
      normalizedFields.push(normalized);
      continue;
    }
    normalizedFields.push(field);
  }

  const normalized = normalizedFields.join(" ");
  try {
    CronExpressionParser.parse(normalized, { strict: false });
    return normalized;
  } catch {
    return null;
  }
}

export function isValidCron(expr: string): boolean {
  return normalizeCronExpressionForParser(expr) !== null;
}

const MS_PER_MINUTE = 60 * 1000;

export function cronMatchesTime(
  expr: string,
  date: Date,
  timezone?: string | null,
): boolean {
  const parserExpression = normalizeCronExpressionForParser(expr);
  if (!parserExpression) return false;

  const minuteStart = toWallClockMinute(date, timezone);
  const windowEnd = new Date(minuteStart.getTime() + MS_PER_MINUTE);

  const previousMinute = new Date(minuteStart.getTime() - 1);
  try {
    const iterator = CronExpressionParser.parse(parserExpression, {
      currentDate: previousMinute,
      tz: "UTC",
    });
    const next = iterator.next().toDate();
    return next >= minuteStart && next < windowEnd;
  } catch {
    return false;
  }
}

function toWallClockMinute(date: Date, timezone?: string | null): Date {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(date);
      const part = (type: "year" | "month" | "day" | "hour" | "minute") =>
        Number.parseInt(
          parts.find((item) => item.type === type)?.value ?? "",
          10,
        );
      return new Date(
        Date.UTC(
          part("year"),
          part("month") - 1,
          part("day"),
          part("hour") % 24,
          part("minute"),
        ),
      );
    } catch {}
  }

  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    ),
  );
}

export function estimatePeriodMs(cron: string): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 0;

  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (
    minute.startsWith("*/") &&
    hour === "*" &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    const step = Number.parseInt(minute.slice(2), 10);
    return step > 0 ? step * 60 * 1000 : 0;
  }

  if (
    !minute.startsWith("*") &&
    hour.startsWith("*/") &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    const step = Number.parseInt(hour.slice(2), 10);
    return step > 0 ? step * 60 * 60 * 1000 : 0;
  }

  if (
    !minute.includes("*") &&
    !hour.includes("*") &&
    dom === "*" &&
    month === "*" &&
    dow === "*"
  ) {
    return 24 * 60 * 60 * 1000;
  }

  return 0;
}
