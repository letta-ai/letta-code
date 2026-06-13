import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { goalLoopMode } from "@/goal-loop-mode";

beforeEach(() => {
  goalLoopMode.deactivate();
});

afterEach(() => {
  goalLoopMode.deactivate();
});

describe("goal loop mode", () => {
  test("activates with objective", () => {
    goalLoopMode.activateGoal("fix the bug");
    const state = goalLoopMode.getState();
    expect(state.isActive).toBe(true);
    expect(state.originalPrompt).toBe("fix the bug");
    expect(state.currentIteration).toBe(1);
  });

  test("sets token budget when provided", () => {
    goalLoopMode.activateGoal("fix the bug", 50000);
    expect(goalLoopMode.getState().tokenBudget).toBe(50000);
  });

  test("defaults token budget to null", () => {
    goalLoopMode.activateGoal("fix the bug");
    expect(goalLoopMode.getState().tokenBudget).toBeNull();
  });

  test("increments iteration", () => {
    goalLoopMode.activateGoal("fix the bug");
    goalLoopMode.incrementIteration();
    expect(goalLoopMode.getState().currentIteration).toBe(2);
  });

  test("detects complete goal status tag while active", () => {
    goalLoopMode.activateGoal("fix the bug");
    expect(
      goalLoopMode.checkForGoalComplete(
        "some text <goal_status>COMPLETE</goal_status> more text",
      ),
    ).toBe(true);
  });

  test("does not detect complete tag when inactive", () => {
    expect(
      goalLoopMode.checkForGoalComplete("<goal_status>complete</goal_status>"),
    ).toBe(false);
  });

  test("deactivate clears goal state", () => {
    goalLoopMode.activateGoal("fix the bug", 50000);
    goalLoopMode.deactivate();
    const state = goalLoopMode.getState();
    expect(state.isActive).toBe(false);
    expect(state.originalPrompt).toBe("");
    expect(state.currentIteration).toBe(0);
    expect(state.tokenBudget).toBeNull();
    expect(state.maxSteps).toBeNull();
  });

  test("stores the max-steps cap when provided", () => {
    goalLoopMode.activateGoal("fix the bug", null, 3);
    expect(goalLoopMode.getState().maxSteps).toBe(3);
  });

  test("defaults max steps to null (unbounded)", () => {
    goalLoopMode.activateGoal("fix the bug");
    expect(goalLoopMode.getState().maxSteps).toBeNull();
  });

  test("hasReachedStepLimit is false when no cap is set", () => {
    goalLoopMode.activateGoal("fix the bug");
    for (let i = 0; i < 5; i++) goalLoopMode.incrementIteration();
    expect(goalLoopMode.hasReachedStepLimit()).toBe(false);
    expect(goalLoopMode.shouldContinue()).toBe(true);
  });

  test("hasReachedStepLimit trips once the cap is reached", () => {
    goalLoopMode.activateGoal("fix the bug", null, 3); // starts at iteration 1
    expect(goalLoopMode.hasReachedStepLimit()).toBe(false);
    goalLoopMode.incrementIteration(); // 2
    expect(goalLoopMode.hasReachedStepLimit()).toBe(false);
    expect(goalLoopMode.shouldContinue()).toBe(true);
    goalLoopMode.incrementIteration(); // 3 == cap
    expect(goalLoopMode.hasReachedStepLimit()).toBe(true);
    expect(goalLoopMode.shouldContinue()).toBe(false);
  });

  test("shouldContinue is false when the loop is inactive", () => {
    expect(goalLoopMode.shouldContinue()).toBe(false);
  });
});
