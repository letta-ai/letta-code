import { describe, expect, test } from "bun:test";
import { decideGoalContinuation } from "@/websocket/listener/goal-continuation";

const base = {
  goalActive: true,
  lastStopReason: "end_turn" as string | null,
  goalStatus: "active" as string | null,
  reachedStepLimit: false,
  tokensUsed: 0,
  tokenBudget: null as number | null,
};

describe("decideGoalContinuation", () => {
  test("continues a clean, active goal turn under all limits", () => {
    expect(decideGoalContinuation(base)).toBe("continue");
  });

  test("stops when the goal loop is not active", () => {
    expect(decideGoalContinuation({ ...base, goalActive: false })).toBe(
      "stop_inactive",
    );
  });

  test("stops when the turn did not end cleanly", () => {
    expect(decideGoalContinuation({ ...base, lastStopReason: null })).toBe(
      "stop_unclean",
    );
    expect(
      decideGoalContinuation({ ...base, lastStopReason: "cancelled" }),
    ).toBe("stop_unclean");
    expect(decideGoalContinuation({ ...base, lastStopReason: "error" })).toBe(
      "stop_unclean",
    );
  });

  test("stops when the goal is no longer active (complete/blocked/paused)", () => {
    for (const goalStatus of ["complete", "blocked", "paused", null]) {
      expect(decideGoalContinuation({ ...base, goalStatus })).toBe(
        "stop_status",
      );
    }
  });

  test("stops when the shared step cap is reached", () => {
    expect(decideGoalContinuation({ ...base, reachedStepLimit: true })).toBe(
      "stop_cap",
    );
  });

  test("stops when the token budget is exhausted", () => {
    expect(
      decideGoalContinuation({ ...base, tokenBudget: 1000, tokensUsed: 1000 }),
    ).toBe("stop_budget");
    expect(
      decideGoalContinuation({ ...base, tokenBudget: 1000, tokensUsed: 1500 }),
    ).toBe("stop_budget");
  });

  test("continues when under the token budget", () => {
    expect(
      decideGoalContinuation({ ...base, tokenBudget: 1000, tokensUsed: 999 }),
    ).toBe("continue");
  });

  test("prioritizes an unclean stop over the active-goal check", () => {
    // A cancelled turn on an otherwise-continuable goal still stops.
    expect(
      decideGoalContinuation({
        ...base,
        lastStopReason: "cancelled",
        goalStatus: "active",
      }),
    ).toBe("stop_unclean");
  });
});
