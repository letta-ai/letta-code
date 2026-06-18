import { describe, expect, test } from "bun:test";
import {
  formatChatGPTUsageSnapshot,
  normalizeWhamUsageResponse,
} from "@/providers/chatgpt-usage-service";

describe("ChatGPT usage service", () => {
  test("normalizes WHAM rate limit windows and builds a compact summary", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-plus-pro",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {
        plan_type: "plus",
        rate_limit: {
          limit_reached: false,
          primary_window: {
            used_percent: 25.5,
            limit_window_seconds: 18_000,
            reset_after_seconds: 7_200,
          },
          secondary_window: {
            used_percent: 12,
            limit_window_seconds: 604_800,
            reset_after_seconds: 432_000,
          },
          additional_rate_limits: [
            {
              name: "extra",
              used_percent: 40,
              window_minutes: 60,
              reset_after_seconds: 1_800,
            },
          ],
        },
        credits: {
          balance: "12.5",
        },
      },
    });

    expect(snapshot.providerName).toBe("chatgpt-plus-pro");
    expect(snapshot.planType).toBe("plus");
    expect(snapshot.limitReached).toBe(false);
    expect(snapshot.primary).toEqual({
      label: "primary",
      usedPercent: 25.5,
      windowDurationMins: 300,
      resetsAt: 1_781_791_200,
    });
    expect(snapshot.secondary?.windowDurationMins).toBe(10_080);
    expect(snapshot.additional[0]).toEqual({
      label: "extra",
      usedPercent: 40,
      windowDurationMins: 60,
      resetsAt: 1_781_785_800,
    });
    expect(snapshot.credits).toEqual({ balance: "12.5" });
    expect(snapshot.summary).toBe(
      "Usage: 5h 74.5% left resets in 2h · 7d 88% left resets in 5d · 1h 60% left resets in 30m · credits 12.5",
    );
  });

  test("accepts camelCase fields and millisecond reset timestamps", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-work",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {
        rateLimit: {
          primaryWindow: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: Date.parse("2026-06-18T15:00:00Z"),
          },
        },
        rateLimitReachedType: "primary",
      },
    });

    expect(snapshot.rateLimitReachedType).toBe("primary");
    expect(snapshot.primary?.resetsAt).toBe(1_781_794_800);
    expect(snapshot.summary).toBe("Usage: 5h 0% left resets in 3h");
  });

  test("formats an empty usage response without throwing", () => {
    const snapshot = normalizeWhamUsageResponse({
      providerName: "chatgpt-plus-pro",
      nowMs: Date.parse("2026-06-18T12:00:00Z"),
      raw: {},
    });

    expect(
      formatChatGPTUsageSnapshot(snapshot, new Date("2026-06-18T12:00:00Z")),
    ).toBe("Usage: no active quota window reported");
  });
});
