import { describe, expect, test } from "bun:test";
import {
  cronMatchesTime,
  estimatePeriodMs,
  isValidCron,
  parseAt,
  parseEvery,
} from "@/cron/parse-interval";

// ── parseEvery ──────────────────────────────────────────────────────

describe("parseEvery", () => {
  test("minutes — clean divisor of 60", () => {
    const result = parseEvery("5m");
    expect(result).not.toBeNull();
    expect(result?.cron).toBe("*/5 * * * *");
    expect(result?.note).toBeUndefined();
  });

  test("minutes — 1m", () => {
    expect(parseEvery("1m")?.cron).toBe("*/1 * * * *");
  });

  test("minutes — non-divisor rounds to nearest", () => {
    const result = parseEvery("7m");
    expect(result).not.toBeNull();
    // 7 rounds to nearest divisor of 60 (5 or 6)
    expect(result?.note).toBeDefined();
  });

  test("hours — clean divisor of 24", () => {
    expect(parseEvery("2h")?.cron).toBe("0 */2 * * *");
    expect(parseEvery("4h")?.cron).toBe("0 */4 * * *");
    expect(parseEvery("6h")?.cron).toBe("0 */6 * * *");
  });

  test("hours — non-divisor rounds", () => {
    const result = parseEvery("5h");
    expect(result).not.toBeNull();
    expect(result?.note).toBeDefined(); // should mention rounding
  });

  test("hours — ≥24h clamps to daily", () => {
    expect(parseEvery("24h")?.cron).toBe("0 0 * * *");
    expect(parseEvery("48h")?.cron).toBe("0 0 * * *");
  });

  test("days — 1d", () => {
    expect(parseEvery("1d")?.cron).toBe("0 0 * * *");
  });

  test("days — multi-day", () => {
    expect(parseEvery("3d")?.cron).toBe("0 0 */3 * *");
    expect(parseEvery("31d")?.cron).toBe("0 0 */31 * *");
  });

  test("days — rejects steps with no legal day-of-month", () => {
    expect(parseEvery("32d")).toBeNull();
  });

  test("seconds — below 60 rounds up to 1m", () => {
    const result = parseEvery("30s");
    expect(result).not.toBeNull();
    expect(result?.cron).toBe("*/1 * * * *");
    expect(result?.note).toContain("Rounded");
  });

  test("seconds — 120s → 2 minutes", () => {
    const result = parseEvery("120s");
    expect(result).not.toBeNull();
    expect(result?.cron).toBe("*/2 * * * *");
  });

  test("various unit spellings", () => {
    expect(parseEvery("5min")).not.toBeNull();
    expect(parseEvery("5mins")).not.toBeNull();
    expect(parseEvery("5minutes")).not.toBeNull();
    expect(parseEvery("2hr")).not.toBeNull();
    expect(parseEvery("2hrs")).not.toBeNull();
    expect(parseEvery("2hours")).not.toBeNull();
    expect(parseEvery("1day")).not.toBeNull();
  });

  test("invalid inputs return null", () => {
    expect(parseEvery("")).toBeNull();
    expect(parseEvery("abc")).toBeNull();
    expect(parseEvery("0m")).toBeNull();
    expect(parseEvery("-5m")).toBeNull();
    expect(parseEvery("5w")).toBeNull(); // weeks not supported
  });
});

// ── parseAt ─────────────────────────────────────────────────────────

describe("parseAt", () => {
  const baseTime = new Date("2026-03-26T10:00:00"); // 10:00 AM local

  test("absolute time — future today", () => {
    const result = parseAt("3:00pm", baseTime);
    expect(result).not.toBeNull();
    expect(result?.scheduledFor.getHours()).toBe(15);
    expect(result?.scheduledFor.getMinutes()).toBe(0);
  });

  test("absolute time — past today → schedules tomorrow", () => {
    const result = parseAt("9:00am", baseTime);
    expect(result).not.toBeNull();
    // Should be tomorrow since 9 AM is before 10 AM
    expect(result?.scheduledFor.getDate()).toBe(baseTime.getDate() + 1);
  });

  test("absolute time — 12:00pm is noon", () => {
    const result = parseAt("12:00pm", baseTime);
    expect(result).not.toBeNull();
    expect(result?.scheduledFor.getHours()).toBe(12);
  });

  test("absolute time — 12:00am is midnight", () => {
    const result = parseAt("12:00am", baseTime);
    expect(result).not.toBeNull();
    expect(result?.scheduledFor.getHours()).toBe(0);
  });

  test("relative time — in 45m", () => {
    const result = parseAt("in 45m", baseTime);
    expect(result).not.toBeNull();
    const expectedMs = baseTime.getTime() + 45 * 60 * 1000;
    expect(result?.scheduledFor.getTime()).toBe(expectedMs);
  });

  test("relative time — in 2h", () => {
    const result = parseAt("in 2h", baseTime);
    expect(result).not.toBeNull();
    const expectedMs = baseTime.getTime() + 2 * 60 * 60 * 1000;
    expect(result?.scheduledFor.getTime()).toBe(expectedMs);
  });

  test("relative time — cron matches the scheduled minute", () => {
    const result = parseAt("in 45m", baseTime);
    expect(result).not.toBeNull();
    expect(result?.cron).toContain(String(result?.scheduledFor.getMinutes()));
  });

  test("invalid inputs return null", () => {
    expect(parseAt("", baseTime)).toBeNull();
    expect(parseAt("foo", baseTime)).toBeNull();
    expect(parseAt("13:00pm", baseTime)).toBeNull(); // 13 > 12
  });
});

// ── isValidCron ─────────────────────────────────────────────────────

describe("isValidCron", () => {
  test("valid expressions", () => {
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 */2 * * *")).toBe(true);
    expect(isValidCron("30 14 * * *")).toBe(true);
    expect(isValidCron("0 0 * * *")).toBe(true);
    expect(isValidCron("0 0 */3 * *")).toBe(true);
    expect(isValidCron("0-59 * * * *")).toBe(true);
  });

  test("valid comma-separated values", () => {
    expect(isValidCron("1,5,9 * * * *")).toBe(true);
    expect(isValidCron("0 1,5,9 * * *")).toBe(true);
    expect(isValidCron("1,5,9,13,17,21 * * * *")).toBe(true);
    expect(isValidCron("0 0 * * 1,3,5")).toBe(true);
  });

  test("valid range with step", () => {
    expect(isValidCron("1-21/4 * * * *")).toBe(true);
    expect(isValidCron("0 0-23/2 * * *")).toBe(true);
  });

  test("valid comma-separated with ranges and steps", () => {
    // Comma-separated items that include ranges
    expect(isValidCron("1-5,10-15 * * * *")).toBe(true);
    // Comma-separated items that include steps
    expect(isValidCron("*/5,*/15 * * * *")).toBe(true);
    // Mixed: exact, range, step
    expect(isValidCron("0,10-20,30-59/5 * * * *")).toBe(true);
  });

  test("accepts overlapping legacy wildcard steps and comma values", () => {
    expect(isValidCron("0 0 */3,15 * *")).toBe(true);
    expect(isValidCron("0 0 */3,2-3 * *")).toBe(true);
    expect(isValidCron("0 0 * */3,6 *")).toBe(true);
  });

  test("invalid expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("* * *")).toBe(false); // too few fields
    expect(isValidCron("* * * * * *")).toBe(false); // too many fields
    expect(isValidCron("abc * * * *")).toBe(false);
    expect(isValidCron("1, * * * *")).toBe(false); // trailing comma
    expect(isValidCron(",5 * * * *")).toBe(false); // leading comma
    expect(isValidCron(", * * * *")).toBe(false); // lone comma
    // The legacy matcher treated N/S as exact N, while cron-parser repeats
    // from N. Reject it instead of silently changing persisted schedules.
    expect(isValidCron("5/10 * * * *")).toBe(false);
  });

  test("rejects out-of-range values and malformed ranges", () => {
    // minute > 59
    expect(isValidCron("60 * * * *")).toBe(false);
    expect(isValidCron("99 99 99 99 *")).toBe(false);
    // hour > 23
    expect(isValidCron("0 24 * * *")).toBe(false);
    // impossible day-of-month
    expect(isValidCron("0 0 32 * *")).toBe(false);
    expect(isValidCron("0 0 0 * *")).toBe(false); // DOM is 1-based
    expect(isValidCron("0 0 */32 * *")).toBe(false); // no legacy DOM value matches
    // impossible month
    expect(isValidCron("0 0 1 13 *")).toBe(false);
    expect(isValidCron("0 0 1 0 *")).toBe(false); // month is 1-based
    expect(isValidCron("0 0 * */13 *")).toBe(false); // no legacy month matches
    // day-of-week > 7
    expect(isValidCron("0 0 * * 8")).toBe(false);
    // out-of-range inside ranges / steps
    expect(isValidCron("0-60 * * * *")).toBe(false); // minute range endpoint > 59
    expect(isValidCron("0 0 1-32 * *")).toBe(false); // DOM range endpoint > 31
    expect(isValidCron("0-59/0 * * * *")).toBe(false); // step must be > 0
    // out-of-range inside a comma list rejects the whole field
    expect(isValidCron("0,60 * * * *")).toBe(false);
    // reversed ranges never match — reject at validation time
    expect(isValidCron("59-0 * * * *")).toBe(false); // minute reversed
    expect(isValidCron("0 0 31-1 * *")).toBe(false); // DOM reversed
  });

  test("accepts valid boundary values for each field", () => {
    expect(isValidCron("0 0 1 1 *")).toBe(true); // min boundaries
    expect(isValidCron("59 23 31 12 *")).toBe(true); // max boundaries
    expect(isValidCron("0 0 * * 0")).toBe(true); // dow 0 (Sunday)
    expect(isValidCron("0 0 * * 7")).toBe(true); // dow 7 (also Sunday)
    expect(isValidCron("0-59 0-23 1-31 1-12 0-7")).toBe(true); // full ranges
  });
});

// ── cronMatchesTime ─────────────────────────────────────────────────

describe("cronMatchesTime", () => {
  test("wildcard matches everything", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("* * * * *", date)).toBe(true);
  });

  test("exact minute match", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("30 * * * *", date)).toBe(true);
    expect(cronMatchesTime("31 * * * *", date)).toBe(false);
  });

  test("step match", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("*/5 * * * *", date)).toBe(true); // 30 % 5 === 0
    expect(cronMatchesTime("*/7 * * * *", date)).toBe(false); // 30 % 7 !== 0
  });

  test("1-based wildcard steps keep the legacy modulo phase", () => {
    expect(
      cronMatchesTime("0 0 */3 * *", new Date("2026-03-03T00:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      cronMatchesTime("0 0 */3 * *", new Date("2026-03-01T00:00:00Z"), "UTC"),
    ).toBe(false);

    expect(
      cronMatchesTime("0 0 * */3 *", new Date("2026-03-01T00:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      cronMatchesTime("0 0 * */3 *", new Date("2026-01-01T00:00:00Z"), "UTC"),
    ).toBe(false);

    expect(
      cronMatchesTime(
        "0 0 1-31/3 * *",
        new Date("2026-03-01T00:00:00Z"),
        "UTC",
      ),
    ).toBe(true);
    expect(
      cronMatchesTime(
        "0 0 1-31/3 * *",
        new Date("2026-03-03T00:00:00Z"),
        "UTC",
      ),
    ).toBe(false);
  });

  test("1-based wildcard steps preserve comma unions without duplicates", () => {
    expect(
      cronMatchesTime(
        "0 0 */3,15 * *",
        new Date("2026-03-15T00:00:00Z"),
        "UTC",
      ),
    ).toBe(true);
    expect(
      cronMatchesTime(
        "0 0 */3,15 * *",
        new Date("2026-03-01T00:00:00Z"),
        "UTC",
      ),
    ).toBe(false);
    expect(
      cronMatchesTime(
        "0 0 */3,2-3 * *",
        new Date("2026-03-02T00:00:00Z"),
        "UTC",
      ),
    ).toBe(true);

    expect(
      cronMatchesTime("0 0 * */3,6 *", new Date("2026-06-01T00:00:00Z"), "UTC"),
    ).toBe(true);
    expect(
      cronMatchesTime("0 0 * */3,6 *", new Date("2026-01-01T00:00:00Z"), "UTC"),
    ).toBe(false);
  });

  test("1-based wildcard steps with no legacy legal values never match", () => {
    expect(
      cronMatchesTime("0 0 */32 * *", new Date("2026-03-01T00:00:00Z"), "UTC"),
    ).toBe(false);
    expect(
      cronMatchesTime("0 0 * */13 *", new Date("2026-01-01T00:00:00Z"), "UTC"),
    ).toBe(false);
  });

  test("range match", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("25-35 * * * *", date)).toBe(true);
    expect(cronMatchesTime("31-35 * * * *", date)).toBe(false);
  });

  test("day of week match", () => {
    // 2026-03-26 is a Thursday (day 4)
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("30 14 * * 4", date)).toBe(true);
    expect(cronMatchesTime("30 14 * * 5", date)).toBe(false);
  });

  test("day of week 7 matches Sunday just like 0", () => {
    // 2026-03-29 is a Sunday. Previously `0 0 * * 7` validated as Sunday but
    // never matched (matcher compared against Date.getDay() 0-6), so it was a
    // valid expression that silently never fired. With cron-parser as the
    // source of truth, 7 and 0 both match Sunday.
    const sunday = new Date("2026-03-29T00:00:00");
    expect(cronMatchesTime("0 0 * * 7", sunday)).toBe(true);
    expect(cronMatchesTime("0 0 * * 0", sunday)).toBe(true);
    // And it does NOT match a non-Sunday.
    const thursday = new Date("2026-03-26T00:00:00");
    expect(cronMatchesTime("0 0 * * 7", thursday)).toBe(false);
  });

  test("full exact match", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("30 14 26 3 *", date)).toBe(true);
    expect(cronMatchesTime("30 14 27 3 *", date)).toBe(false);
  });

  test("day-of-month and day-of-week OR semantics", () => {
    // 2026-03-26 is a Thursday (day 4), day-of-month 26
    const date = new Date("2026-03-26T09:00:00");

    // Both constrained: "0 9 15 * 4" = 15th OR Thursday → should fire (it's Thursday)
    expect(cronMatchesTime("0 9 15 * 4", date)).toBe(true);

    // Both constrained: "0 9 26 * 1" = 26th OR Monday → should fire (it's the 26th)
    expect(cronMatchesTime("0 9 26 * 1", date)).toBe(true);

    // Both constrained: "0 9 15 * 1" = 15th OR Monday → neither matches
    expect(cronMatchesTime("0 9 15 * 1", date)).toBe(false);

    // Only day-of-month constrained (dow is *): AND logic
    expect(cronMatchesTime("0 9 26 * *", date)).toBe(true);
    expect(cronMatchesTime("0 9 15 * *", date)).toBe(false);

    // Only day-of-week constrained (dom is *): AND logic
    expect(cronMatchesTime("0 9 * * 4", date)).toBe(true);
    expect(cronMatchesTime("0 9 * * 1", date)).toBe(false);

    // A normalized legacy wildcard step remains constrained and retains OR.
    expect(
      cronMatchesTime("0 0 */3 * 1", new Date("2026-03-02T00:00:00Z"), "UTC"),
    ).toBe(true); // Monday
    expect(
      cronMatchesTime("0 0 */3 * 1", new Date("2026-03-03T00:00:00Z"), "UTC"),
    ).toBe(true); // divisible day-of-month
    expect(
      cronMatchesTime("0 0 */3 * 1", new Date("2026-03-04T00:00:00Z"), "UTC"),
    ).toBe(false);
  });

  test("timezone-aware matching", () => {
    // Create a UTC date: 2026-03-26 at 22:30 UTC
    const utcDate = new Date("2026-03-26T22:30:00Z");

    // In UTC, this is hour 22, minute 30
    expect(cronMatchesTime("30 22 * * *", utcDate, "UTC")).toBe(true);
    expect(cronMatchesTime("30 15 * * *", utcDate, "UTC")).toBe(false);

    // In America/Los_Angeles (PDT, UTC-7), 22:30 UTC = 15:30 local
    expect(cronMatchesTime("30 15 * * *", utcDate, "America/Los_Angeles")).toBe(
      true,
    );
    expect(cronMatchesTime("30 22 * * *", utcDate, "America/Los_Angeles")).toBe(
      false,
    );

    // In Asia/Tokyo (JST, UTC+9), 22:30 UTC = 07:30 next day (March 27)
    expect(cronMatchesTime("30 7 27 3 *", utcDate, "Asia/Tokyo")).toBe(true);
    expect(cronMatchesTime("30 22 26 3 *", utcDate, "Asia/Tokyo")).toBe(false);
  });

  test("preserves the absolute minute across the host DST fallback fold", () => {
    const script = `
      import { cronMatchesTime } from "./src/cron/parse-interval";
      const secondOneThirty = new Date("2026-11-01T09:30:45Z");
      console.log(JSON.stringify({
        due: cronMatchesTime("30 9 * * *", secondOneThirty, "UTC"),
        previousHour: cronMatchesTime("30 8 * * *", secondOneThirty, "UTC"),
      }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, TZ: "America/Los_Angeles" },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      due: true,
      previousHour: false,
    });
  });

  test("invalid timezone falls back to local time", () => {
    const date = new Date("2026-03-26T14:30:00");
    // Invalid timezone should not throw, should match same as no timezone
    expect(cronMatchesTime("30 14 * * *", date, "Invalid/Timezone")).toBe(
      cronMatchesTime("30 14 * * *", date),
    );
  });

  test("null/undefined timezone uses local time", () => {
    const date = new Date("2026-03-26T14:30:00");
    expect(cronMatchesTime("30 14 * * *", date, null)).toBe(true);
    expect(cronMatchesTime("30 14 * * *", date, undefined)).toBe(true);
  });

  test("comma-separated values match", () => {
    const date = new Date("2026-03-26T14:30:00");
    // minute 30 is in the list 0,15,30,45
    expect(cronMatchesTime("0,15,30,45 * * * *", date)).toBe(true);
    // minute 30 is NOT in the list 1,5,9
    expect(cronMatchesTime("1,5,9 * * * *", date)).toBe(false);
    // comma-separated day-of-week: Thursday is 4
    expect(cronMatchesTime("30 14 * * 1,3,5", date)).toBe(false); // not Mon/Wed/Fri
    expect(cronMatchesTime("30 14 * * 1,4,5", date)).toBe(true); // Thu is in list
  });

  test("range with step matches", () => {
    const date = new Date("2026-03-26T14:30:00");
    // 1-21/4 → 1,5,9,13,17,21 → 30 is NOT in this set
    expect(cronMatchesTime("1-21/4 * * * *", date)).toBe(false);
    // 0-59/15 → 0,15,30,45 → 30 IS in this set
    expect(cronMatchesTime("0-59/15 * * * *", date)).toBe(true);
    // Range with step for hour: 14 is in 0-23/2 → 0,2,4,...,14,...,22
    expect(cronMatchesTime("* 0-23/2 * * *", date)).toBe(true);
  });

  test("comma-separated with ranges", () => {
    const date = new Date("2026-03-26T14:30:00");
    // 10-20,30-40 → minute 30 is in 30-40 range
    expect(cronMatchesTime("10-20,30-40 * * * *", date)).toBe(true);
    // 1-5,10-15 → minute 30 is NOT in either range
    expect(cronMatchesTime("1-5,10-15 * * * *", date)).toBe(false);
  });
});

// ── estimatePeriodMs ────────────────────────────────────────────────

describe("estimatePeriodMs", () => {
  test("every N minutes", () => {
    expect(estimatePeriodMs("*/5 * * * *")).toBe(5 * 60 * 1000);
    expect(estimatePeriodMs("*/1 * * * *")).toBe(60 * 1000);
  });

  test("every N hours", () => {
    expect(estimatePeriodMs("0 */2 * * *")).toBe(2 * 60 * 60 * 1000);
    expect(estimatePeriodMs("0 */6 * * *")).toBe(6 * 60 * 60 * 1000);
  });

  test("daily", () => {
    expect(estimatePeriodMs("30 14 * * *")).toBe(24 * 60 * 60 * 1000);
  });

  test("complex expressions return 0", () => {
    expect(estimatePeriodMs("0 0 */3 * *")).toBe(0);
    expect(estimatePeriodMs("0 0 * * 1-5")).toBe(0);
  });
});
