/**
 * Parse human-friendly interval strings into 5-field cron expressions.
 *
 * Supported formats:
 *   --every 5m        → "∗/5 ∗ ∗ ∗ ∗"
 *   --every 2h        → "0 ∗/2 ∗ ∗ ∗"
 *   --every 1d        → "0 0 ∗ ∗ ∗"
 *   --at "3:00pm"     → one-shot cron + scheduledFor (UTC)
 *   --at "in 45m"     → one-shot cron + scheduledFor (UTC)
 *   --cron "∗/10 ∗ ∗ ∗ ∗"  → passthrough
 */

import { CronExpressionParser } from "cron-parser";

// ── Interval parsing (--every) ──────────────────────────────────────

export interface ParsedInterval {
  cron: string;
  /** Human-readable summary of what was parsed / any rounding applied. */
  note?: string;
}

const INTERVAL_RE =
  /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days?)$/i;

/**
 * Parse an --every value (e.g. "5m", "2h", "1d") into a 5-field cron expression.
 * Returns null if the string is not a valid interval.
 */
export function parseEvery(input: string): ParsedInterval | null {
  const match = input.trim().match(INTERVAL_RE);
  if (!match) return null;

  const value = Number.parseInt(match[1] ?? "", 10);
  if (value <= 0 || !Number.isFinite(value)) return null;

  const unit = (match[2] ?? "").toLowerCase();

  // Seconds → round up to 1-minute minimum
  if (unit.startsWith("s")) {
    if (value < 60) {
      return {
        cron: "*/1 * * * *",
        note: `Rounded ${value}s up to 1m (minimum granularity is 1 minute)`,
      };
    }
    // >= 60s → convert to minutes
    const mins = Math.round(value / 60);
    return minuteCron(mins);
  }

  // Minutes
  if (unit.startsWith("m")) {
    return minuteCron(value);
  }

  // Hours
  if (unit.startsWith("h")) {
    if (value >= 24) {
      return { cron: "0 0 * * *", note: `${value}h clamped to daily` };
    }
    if (24 % value === 0) {
      return { cron: `0 */${value} * * *` };
    }
    // Non-clean divisor: use closest divisor of 24
    const divisors = [1, 2, 3, 4, 6, 8, 12, 24];
    const closest = divisors.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev,
    );
    return {
      cron: `0 */${closest} * * *`,
      note: `${value}h rounded to every ${closest}h (nearest clean divisor of 24)`,
    };
  }

  // Days
  if (unit.startsWith("d")) {
    if (value === 1) {
      return { cron: "0 0 * * *" };
    }
    // Multi-day: use day-of-month step
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

  // Clean divisors of 60
  if (60 % mins === 0) {
    return { cron: `*/${mins} * * * *` };
  }

  // Round to nearest clean divisor of 60
  const divisors = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
  const closest = divisors.reduce((prev, curr) =>
    Math.abs(curr - mins) < Math.abs(prev - mins) ? curr : prev,
  );
  return {
    cron: `*/${closest} * * * *`,
    note: `${mins}m rounded to every ${closest}m (nearest clean divisor of 60)`,
  };
}

// ── Time parsing (--at) ─────────────────────────────────────────────

export interface ParsedAt {
  /** Absolute UTC time to fire. */
  scheduledFor: Date;
  /** A cron expression that would match the scheduledFor time (for display only). */
  cron: string;
  note?: string;
}

const TIME_RE = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i;
const RELATIVE_RE = /^in\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/i;

/**
 * Parse an --at value (e.g. "3:00pm", "in 45m") into an absolute scheduled time.
 * All times are interpreted in the user's local timezone.
 */
export function parseAt(input: string, now?: Date): ParsedAt | null {
  const trimmed = input.trim();
  const currentTime = now ?? new Date();

  // Relative time: "in 45m", "in 2h"
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

  // Absolute time: "3:00pm", "11:30am"
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

    // If the time has already passed today, schedule for tomorrow
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

/** Convert a Date to a 5-field cron expression matching that specific minute. */
function dateToCron(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

// ── Cron validation ─────────────────────────────────────────────────

/**
 * Product dialect gate: we only accept the classic 5-field numeric cron
 * syntax (digits, `*`, `,`, `-`, `/`, whitespace). Names like `MON`/`JAN`,
 * `?`, `L`, `#` are rejected so we can hand the expression to cron-parser
 * without expanding the supported surface, and so users get a consistent
 * dialect across `--every`, `--at`, and `--cron`.
 */
const SUPPORTED_CRON_RE = /^[\d\s*,*/-]+$/;

const DAY_OF_MONTH_FIELD_INDEX = 2;
const MONTH_FIELD_INDEX = 3;

/**
 * The legacy matcher anchored wildcard steps at zero in every field. Standard
 * cron anchors them at each field's minimum, which is one for day-of-month and
 * month. Preserve the existing Letta dialect by translating those two fields
 * to equivalent explicit ranges before handing them to cron-parser:
 *
 *   day-of-month wildcard/3 -> `3-31/3` (3, 6, 9, ...)
 *   month wildcard/2       -> `2-12/2` (2, 4, 6, ...)
 *
 * This also makes oversized day-of-month wildcard steps invalid instead
 * of silently changing them from "never" to the first day of every month.
 */
function preserveLegacyWildcardStepSemantics(fields: string[]): string[] {
  return fields.map((field, index) => {
    const maximum =
      index === DAY_OF_MONTH_FIELD_INDEX
        ? 31
        : index === MONTH_FIELD_INDEX
          ? 12
          : null;
    if (maximum === null) return field;

    return field
      .split(",")
      .map((part) => {
        const match = part.match(/^\*\/(\d+)$/);
        if (!match) return part;
        const step = Number.parseInt(match[1] ?? "", 10);
        return `${step}-${maximum}/${step}`;
      })
      .join(",");
  });
}

/**
 * The legacy matcher accepted bare value steps (`N/S`) but treated them as
 * the single value `N`. cron-parser gives them standard step semantics, which
 * would silently make persisted schedules run more often after an upgrade.
 * Keep them outside the product dialect; wildcard steps and ranged steps
 * remain supported.
 */
function hasBareValueStep(fields: string[]): boolean {
  return fields.some((field) =>
    field.split(",").some((part) => /^\d+\/\d+$/.test(part)),
  );
}

/** Return the normalized expression accepted by the Letta cron dialect. */
function normalizeSupportedCronExpression(expr: string): string | null {
  const trimmed = expr.trim();
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return null;
  if (!SUPPORTED_CRON_RE.test(trimmed)) return null;
  if (hasBareValueStep(fields)) return null;
  return preserveLegacyWildcardStepSemantics(fields).join(" ");
}

/**
 * Validate a 5-field cron expression using cron-parser as the source of truth
 * for cron semantics, so that validation and execution (cronMatchesTime) can
 * never disagree. Rejects out-of-range values (`99 99 * * *`, `0 0 32 * *`),
 * reversed ranges (`59-0 * * * *`), zero steps (`0-59/0 * * * *`), and any
 * non-numeric syntax — all of which previously parsed as "valid" and then
 * either never fired or fired with surprising semantics.
 */
export function isValidCron(expr: string): boolean {
  const normalized = normalizeSupportedCronExpression(expr);
  if (!normalized) return false;
  try {
    CronExpressionParser.parse(normalized, { strict: false });
    return true;
  } catch {
    return false;
  }
}

// ── Cron evaluation ─────────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;

/**
 * Check if a cron expression matches a given date/time (minute-level).
 *
 * Delegates to cron-parser so that matching and validation share one source
 * of truth: an expression is "valid" iff cron-parser accepts it, and it
 * "matches" a minute iff cron-parser's next occurrence after the previous
 * minute lands within that minute. This removes the long-standing mismatch
 * where e.g. day-of-week `7` validated as Sunday but never matched
 * `Date.getDay()` (0-6).
 *
 * When `timezone` is provided, the cron field semantics are interpreted in
 * that IANA timezone (cron-parser applies the offset/DST rules itself). An
 * invalid/unavailable timezone falls back to the process local timezone
 * rather than throwing, matching the previous behavior.
 */
export function cronMatchesTime(
  expr: string,
  date: Date,
  timezone?: string | null,
): boolean {
  const normalized = normalizeSupportedCronExpression(expr);
  if (!normalized) return false;

  // Align to the start of the target minute (drop seconds/ms) so the window
  // check is stable regardless of when within the minute `date` falls.
  const minuteStart = new Date(
    Math.floor(date.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE,
  );
  const windowEnd = new Date(minuteStart.getTime() + MS_PER_MINUTE);

  // Ask cron-parser for the first occurrence strictly after the previous
  // minute; if the expression fires in `minuteStart`'s minute, that occurrence
  // lands inside [minuteStart, windowEnd).
  const previousMinute = new Date(minuteStart.getTime() - 1);
  try {
    const iterator = CronExpressionParser.parse(normalized, {
      currentDate: previousMinute,
      tz: resolveTimezone(timezone),
    });
    const next = iterator.next().toDate();
    return next >= minuteStart && next < windowEnd;
  } catch {
    return false;
  }
}

/**
 * Return the IANA timezone to pass to cron-parser, or undefined to use the
 * process local timezone. Invalid/unavailable timezones fall back to local
 * (undefined) rather than throwing, preserving the previous behavior.
 */
function resolveTimezone(timezone?: string | null): string | undefined {
  if (!timezone) return undefined;
  try {
    // Throws on unknown IANA names — cheap way to validate before handing it
    // to cron-parser, which would otherwise throw from deep in its internals.
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return undefined;
  }
}

// ── Period estimation (for jitter) ──────────────────────────────────

/**
 * Estimate the period (in ms) of a cron expression for jitter calculation.
 * Only handles common patterns; returns 0 for complex expressions.
 */
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

  // */N * * * * → every N minutes
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

  // N */H * * * → every H hours
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

  // N N * * * → daily (specific minute + hour)
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
