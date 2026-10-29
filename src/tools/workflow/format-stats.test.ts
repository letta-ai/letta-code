import { describe, expect, test } from "bun:test";
import {
  formatCompactTokens,
  formatWorkflowDuration,
  formatWorkflowProgress,
  formatWorkflowSummary,
} from "./format-stats.ts";

describe("format-stats", () => {
  test("formatCompactTokens", () => {
    expect(formatCompactTokens(0)).toBe("0");
    expect(formatCompactTokens(500)).toBe("500");
    expect(formatCompactTokens(5_200)).toBe("5.2k");
    expect(formatCompactTokens(167_200)).toBe("167.2k");
    expect(formatCompactTokens(1_000_000)).toBe("1M");
    expect(formatCompactTokens(2_450_000)).toBe("2.5M");
    expect(formatCompactTokens(Number.NaN)).toBe("0");
  });

  test("formatWorkflowDuration", () => {
    expect(formatWorkflowDuration(9_400)).toBe("9s");
    expect(formatWorkflowDuration(65_000)).toBe("1m 05s");
    expect(formatWorkflowDuration(3_725_000)).toBe("1h 02m");
    expect(formatWorkflowDuration(-5)).toBe("0s");
  });

  test("progress and summary omit tokens until reported", () => {
    const stats = {
      durationMs: 9_000,
      agentsDone: 2,
      agentsTotal: 3,
      totalTokens: 0,
    };
    expect(formatWorkflowProgress(stats)).toBe("2/3 agents done · 9s");
    expect(formatWorkflowProgress({ ...stats, totalTokens: 133_600 })).toBe(
      "2/3 agents done · 9s · 133.6k tokens",
    );
    expect(
      formatWorkflowSummary({
        durationMs: 36_000,
        agentsDone: 4,
        agentsTotal: 4,
        totalTokens: 167_200,
      }),
    ).toBe("36s · 4 agents · 167.2k tokens");
    expect(
      formatWorkflowSummary({
        durationMs: 1_000,
        agentsDone: 1,
        agentsTotal: 1,
        totalTokens: 0,
      }),
    ).toBe("1s · 1 agent");
  });
});
