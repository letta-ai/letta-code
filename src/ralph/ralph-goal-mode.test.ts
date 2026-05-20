import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ralphMode } from "@/ralph/mode";

beforeEach(() => {
  ralphMode.deactivate();
});

afterEach(() => {
  ralphMode.deactivate();
});

// ============================================================================
// activateGoal
// ============================================================================

describe("ralph mode - activateGoal", () => {
  test("activates with goal mode", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    const state = ralphMode.getState();
    expect(state.isActive).toBe(true);
    expect(state.mode).toBe("goal");
    expect(state.originalPrompt).toBe("fix the bug");
    expect(state.isYolo).toBe(false);
  });

  test("activates with yolo + goal mode", () => {
    ralphMode.activateGoal("fix the bug", 0, true);
    const state = ralphMode.getState();
    expect(state.isYolo).toBe(true);
    expect(state.mode).toBe("goal");
  });

  test("sets token budget when provided", () => {
    ralphMode.activateGoal("fix the bug", 0, false, 50000);
    const state = ralphMode.getState();
    expect(state.tokenBudget).toBe(50000);
  });

  test("defaults token budget to null", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    const state = ralphMode.getState();
    expect(state.tokenBudget).toBeNull();
  });

  test("sets completion promise to null (no promise check)", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    const state = ralphMode.getState();
    expect(state.completionPromise).toBeNull();
  });
});

// ============================================================================
// checkForGoalComplete
// ============================================================================

describe("ralph mode - checkForGoalComplete", () => {
  test("detects <goal_status>complete</goal_status>", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    expect(
      ralphMode.checkForGoalComplete(
        "some text <goal_status>complete</goal_status> more text",
      ),
    ).toBe(true);
  });

  test("is case insensitive", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    expect(
      ralphMode.checkForGoalComplete("<goal_status>COMPLETE</goal_status>"),
    ).toBe(true);
  });

  test("returns false in ralph mode", () => {
    ralphMode.activate("fix the bug", undefined, 0, false);
    expect(
      ralphMode.checkForGoalComplete("<goal_status>complete</goal_status>"),
    ).toBe(false);
  });

  test("returns false when not active", () => {
    expect(
      ralphMode.checkForGoalComplete("<goal_status>complete</goal_status>"),
    ).toBe(false);
  });

  test("returns false for non-complete status", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    expect(
      ralphMode.checkForGoalComplete("<goal_status>paused</goal_status>"),
    ).toBe(false);
  });
});

// ============================================================================
// checkForCompletion dispatch
// ============================================================================

describe("ralph mode - checkForCompletion dispatch", () => {
  test("delegates to checkForGoalComplete in goal mode", () => {
    ralphMode.activateGoal("fix the bug", 0, false);
    expect(
      ralphMode.checkForCompletion("<goal_status>complete</goal_status>"),
    ).toBe(true);
  });

  test("delegates to checkForPromise in ralph mode", () => {
    ralphMode.activate("fix the bug", undefined, 0, false);
    // Default promise is set, so this should not match random text
    expect(ralphMode.checkForCompletion("random text")).toBe(false);
  });
});

// ============================================================================
// deactivate resets goal fields
// ============================================================================

describe("ralph mode - deactivate resets goal state", () => {
  test("deactivate clears goal mode and token budget", () => {
    ralphMode.activateGoal("fix the bug", 0, false, 50000);
    expect(ralphMode.getState().mode).toBe("goal");
    expect(ralphMode.getState().tokenBudget).toBe(50000);

    ralphMode.deactivate();
    const state = ralphMode.getState();
    expect(state.isActive).toBe(false);
    expect(state.mode).toBe("ralph");
    expect(state.tokenBudget).toBeNull();
  });
});
