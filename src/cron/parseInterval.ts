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
    return { cron: `0 0 */${value} * *` };
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

const CRON_FIELD_RE = /^(\*|\d+)([/-]\d+)?$/;

/**
 * Validate a 5-field cron expression. Very basic — checks field count and
 * each field matches `*`, `N`, `*​/N`, or `N-N` patterns.
 */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => CRON_FIELD_RE.test(f));
}

// ── Cron evaluation ─────────────────────────────────────────────────

/**
 * Check if a cron expression matches a given date/time (minute-level).
 * Supports: `*`, `N`, `*​/N` (step), `N-N` (range) per field.
 * Fields: minute, hour, day-of-month, month, day-of-week.
 */
export function cronMatchesTime(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(), // 0=Sun
  ];

  return fields.every((field, i) => fieldMatches(field, values[i] ?? 0));
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  // Step: */N
  if (field.startsWith("*/")) {
    const step = Number.parseInt(field.slice(2), 10);
    if (step <= 0 || !Number.isFinite(step)) return false;
    return value % step === 0;
  }

  // Range: N-N
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = Number.parseInt(startStr ?? "", 10);
    const end = Number.parseInt(endStr ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return value >= start && value <= end;
  }

  // Exact
  const exact = Number.parseInt(field, 10);
  return Number.isFinite(exact) && value === exact;
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
