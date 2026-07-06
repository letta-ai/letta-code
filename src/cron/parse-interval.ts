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

/** Matches a single cron sub-field (no commas): *, N, star/N, N-M, N-M/S */
const CRON_SUBFIELD_RE = /^(\*|\d+)(-\d+)?(\/\d+)?$/;

/**
 * Per-field value ranges for standard 5-field cron.
 * Day-of-week allows 0-7 (both 0 and 7 denote Sunday), per POSIX.
 */
const CRON_FIELD_RANGES: ReadonlyArray<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

/**
 * Validate a single numeric token against a field's value range.
 * A token is one of: a single value N, a range N-M, a star step (star/S),
 * or a ranged step N-M/S. Every literal number must fall within [min, max].
 */
function cronSubFieldInRange(
  subField: string,
  min: number,
  max: number,
): boolean {
  // Bare wildcard — always in range.
  if (subField === "*") return true;

  // `*/S` — only the step needs to be a positive integer (no base value to bound).
  if (subField.startsWith("*/")) {
    const step = Number.parseInt(subField.slice(2), 10);
    return Number.isFinite(step) && step > 0;
  }

  // Strip an optional `/S` step suffix, then validate the base (`N` or `N-M`).
  const slashIdx = subField.indexOf("/");
  if (slashIdx !== -1) {
    const step = Number.parseInt(subField.slice(slashIdx + 1), 10);
    if (!Number.isFinite(step) || step <= 0) return false;
  }
  const base = subField.split("/")[0] ?? "";
  const parts = base.split("-");
  if (parts.length < 1 || parts.length > 2) return false;

  const nums = parts.map((p) => Number.parseInt(p ?? "", 10));
  if (nums.some((n) => !Number.isFinite(n))) return false;
  // Every literal number must lie within the field's range.
  return nums.every((n) => n >= min && n <= max);
}

/**
 * Validate a 5-field cron expression. Checks field count, shape of each
 * sub-field (wildcards, exact values, steps, ranges, range-steps, comma lists),
 * AND that every literal number falls within its field's value range — so that
 * expressions like `99 99 * * *` or `0 0 32 13 *` are rejected instead of being
 * accepted and then never firing.
 */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, fieldIndex) => {
    const [min, max] = CRON_FIELD_RANGES[fieldIndex] ?? [0, 0];
    // Split on commas and validate each sub-field individually
    const subFields = f.split(",");
    // Reject empty sub-fields (trailing/leading/double commas)
    if (subFields.some((s) => s === "")) return false;
    return subFields.every((s) => {
      if (!CRON_SUBFIELD_RE.test(s)) return false;
      return cronSubFieldInRange(s, min, max);
    });
  });
}

// ── Cron evaluation ─────────────────────────────────────────────────

/**
 * Derive minute/hour/day/month/dow for a Date in a given IANA timezone.
 * Falls back to local time if the timezone is invalid or unavailable.
 *
 * Note on DST: Standard cron semantics apply — if a wall-clock minute is
 * skipped during spring-forward, tasks scheduled for that minute won't fire.
 * If a wall-clock hour repeats during fall-back, tasks may fire twice (once
 * per occurrence of the matching minute).
 */
function getTimeComponents(
  date: Date,
  timezone?: string | null,
): [
  minute: number,
  hour: number,
  dayOfMonth: number,
  month: number,
  dayOfWeek: number,
] {
  if (!timezone) {
    return [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];
  }
  try {
    // Intl.DateTimeFormat gives us wall-clock components in the target tz.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hour12: false,
    });
    const parts = new Map(
      fmt.formatToParts(date).map((p) => [p.type, p.value]),
    );

    const dayOfWeekStr = parts.get("weekday") ?? "";
    const dowMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };

    return [
      Number.parseInt(parts.get("minute") ?? "0", 10),
      Number.parseInt(parts.get("hour") ?? "0", 10),
      Number.parseInt(parts.get("day") ?? "1", 10),
      Number.parseInt(parts.get("month") ?? "1", 10),
      dowMap[dayOfWeekStr] ?? date.getDay(),
    ];
  } catch {
    // Invalid timezone — fall back to local time.
    return [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay(),
    ];
  }
}

/**
 * Check if a cron expression matches a given date/time (minute-level).
 * Supports: *, N, step (N), range (N-N) per field.
 * Fields: minute, hour, day-of-month, month, day-of-week.
 *
 * Standard cron day semantics: when both day-of-month (field 2) and
 * day-of-week (field 4) are constrained (not `*`), the result is OR —
 * the expression fires if either day condition matches. When only one is
 * constrained, it behaves as a normal AND with the other fields.
 *
 * When `timezone` is provided, the date is evaluated in that IANA timezone
 * rather than the process's local timezone.
 */
export function cronMatchesTime(
  expr: string,
  date: Date,
  timezone?: string | null,
): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = getTimeComponents(
    date,
    timezone,
  );

  // Destructure after length check so Biome doesn't complain about non-null.
  const [fMinute, fHour, fDom, fMonth, fDow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Minute, hour, month must always match.
  if (!fieldMatches(fMinute, minute)) return false;
  if (!fieldMatches(fHour, hour)) return false;
  if (!fieldMatches(fMonth, month)) return false;

  const domField = fDom;
  const dowField = fDow;
  const domConstrained = domField !== "*";
  const dowConstrained = dowField !== "*";

  if (domConstrained && dowConstrained) {
    // Standard cron OR: fire if either day-of-month or day-of-week matches.
    return (
      fieldMatches(domField, dayOfMonth) || fieldMatches(dowField, dayOfWeek)
    );
  }

  // One or neither constrained — AND logic (unconstrained fields always match).
  return (
    fieldMatches(domField, dayOfMonth) && fieldMatches(dowField, dayOfWeek)
  );
}

function fieldMatches(field: string, value: number): boolean {
  // Comma-separated: any sub-field matching is enough
  if (field.includes(",")) {
    return field.split(",").some((sub) => fieldMatches(sub, value));
  }

  if (field === "*") return true;

  // Step: */N
  if (field.startsWith("*/")) {
    const step = Number.parseInt(field.slice(2), 10);
    if (step <= 0 || !Number.isFinite(step)) return false;
    return value % step === 0;
  }

  // Range with step: N-M/S
  if (field.includes("-") && field.includes("/")) {
    const [range, stepStr] = field.split("/");
    const step = Number.parseInt(stepStr ?? "", 10);
    if (step <= 0 || !Number.isFinite(step)) return false;
    const [startStr, endStr] = (range ?? "").split("-");
    const start = Number.parseInt(startStr ?? "", 10);
    const end = Number.parseInt(endStr ?? "", 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return value >= start && value <= end && (value - start) % step === 0;
  }

  // Range: N-M
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
