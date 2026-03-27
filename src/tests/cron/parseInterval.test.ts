import { describe, expect, test } from "bun:test";
import {
  cronMatchesTime,
  estimatePeriodMs,
  isValidCron,
  parseAt,
  parseEvery,
} from "../../cron/parseInterval";

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

  test("invalid expressions", () => {
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("* * *")).toBe(false); // too few fields
    expect(isValidCron("* * * * * *")).toBe(false); // too many fields
    expect(isValidCron("abc * * * *")).toBe(false);
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
