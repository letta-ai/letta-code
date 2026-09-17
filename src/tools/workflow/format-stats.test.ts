import { describe, expect, test } from "bun:test";
import {
  formatCompactTokens,
  formatWorkflowDuration,
  formatWorkflowProgress,
  formatWorkflowSummary,
} from "./format-stats.ts";

describe("formatCompactTokens", () => {
  test("keeps one decimal for thousands and millions", () => {
    expect(formatCompactTokens(500)).toBe("500");
    expect(formatCompactTokens(5200)).toBe("5.2k");
    expect(formatCompactTokens(133_600)).toBe("133.6k");
    expect(formatCompactTokens(167_200)).toBe("167.2k");
    expect(formatCompactTokens(10_000)).toBe("10k");
    expect(formatCompactTokens(2_400_000)).toBe("2.4M");
  });

  test("clamps nonsense to zero", () => {
    expect(formatCompactTokens(-5)).toBe("0");
    expect(formatCompactTokens(Number.NaN)).toBe("0");
  });
});

describe("formatWorkflowDuration", () => {
  test("uses seconds, minutes, then hours", () => {
    expect(formatWorkflowDuration(9_400)).toBe("9s");
    expect(formatWorkflowDuration(36_000)).toBe("36s");
    expect(formatWorkflowDuration(65_000)).toBe("1m 05s");
    expect(formatWorkflowDuration(3_725_000)).toBe("1h 02m");
  });
});

describe("progress and summary fragments", () => {
  test("progress shows done/total, elapsed, and tokens when known", () => {
    expect(
      formatWorkflowProgress({
        durationMs: 9_000,
        agentsDone: 0,
        agentsTotal: 3,
        totalTokens: 133_600,
      }),
    ).toBe("0/3 agents done · 9s · ↓ 133.6k tokens");
    expect(
      formatWorkflowProgress({
        durationMs: 1_000,
        agentsDone: 0,
        agentsTotal: 0,
        totalTokens: 0,
      }),
    ).toBe("0/0 agents done · 1s");
  });

  test("summary shows duration, agent count, and tokens", () => {
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
        durationMs: 2_000,
        agentsDone: 1,
        agentsTotal: 1,
        totalTokens: 0,
      }),
    ).toBe("2s · 1 agent");
  });
});
