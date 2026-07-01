// Goal loop state management.
// Singleton pattern matching src/permissions/mode.ts.

export type GoalLoopState = {
  isActive: boolean;
  originalPrompt: string;
  currentIteration: number;
  tokenBudget: number | null;
  // Max number of autonomous continuation turns before the loop stops itself.
  // `null` means unbounded (the legacy behavior).
  maxSteps: number | null;
};

// Use globalThis to ensure singleton across bundle.
const GOAL_LOOP_KEY = Symbol.for("@letta/goalLoopMode");

type GlobalWithGoalLoop = typeof globalThis & {
  [GOAL_LOOP_KEY]: GoalLoopState;
};

function getDefaultState(): GoalLoopState {
  return {
    isActive: false,
    originalPrompt: "",
    currentIteration: 0,
    tokenBudget: null,
    maxSteps: null,
  };
}

function getGlobalState(): GoalLoopState {
  const global = globalThis as GlobalWithGoalLoop;
  if (!global[GOAL_LOOP_KEY]) {
    global[GOAL_LOOP_KEY] = getDefaultState();
  }
  return global[GOAL_LOOP_KEY];
}

function setGlobalState(state: GoalLoopState): void {
  const global = globalThis as GlobalWithGoalLoop;
  global[GOAL_LOOP_KEY] = state;
}

class GoalLoopModeManager {
  activateGoal(
    objective: string,
    tokenBudget: number | null = null,
    maxSteps: number | null = null,
  ): void {
    setGlobalState({
      isActive: true,
      originalPrompt: objective,
      currentIteration: 1,
      tokenBudget,
      maxSteps,
    });
  }

  deactivate(): void {
    setGlobalState(getDefaultState());
  }

  getState(): GoalLoopState {
    return getGlobalState();
  }

  incrementIteration(): void {
    const state = getGlobalState();
    setGlobalState({
      ...state,
      currentIteration: state.currentIteration + 1,
    });
  }

  checkForGoalComplete(text: string): boolean {
    const state = getGlobalState();
    if (!state.isActive) return false;
    return /<goal_status>\s*complete\s*<\/goal_status>/i.test(text);
  }

  /**
   * True once the loop has run at least `maxSteps` autonomous turns. Returns
   * false when no cap is configured (`maxSteps === null`).
   */
  hasReachedStepLimit(): boolean {
    const state = getGlobalState();
    return state.maxSteps !== null && state.currentIteration >= state.maxSteps;
  }

  shouldContinue(): boolean {
    const state = getGlobalState();
    // Defense in depth: even if a caller forgets the explicit step-limit
    // check, never continue past the configured cap.
    return state.isActive && !this.hasReachedStepLimit();
  }
}

export const goalLoopMode = new GoalLoopModeManager();
