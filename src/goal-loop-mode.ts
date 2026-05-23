// Goal loop state management.
// Singleton pattern matching src/permissions/mode.ts.

export type GoalLoopState = {
  isActive: boolean;
  originalPrompt: string;
  currentIteration: number;
  tokenBudget: number | null;
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
  activateGoal(objective: string, tokenBudget: number | null = null): void {
    setGlobalState({
      isActive: true,
      originalPrompt: objective,
      currentIteration: 1,
      tokenBudget,
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

  shouldContinue(): boolean {
    return getGlobalState().isActive;
  }
}

export const goalLoopMode = new GoalLoopModeManager();
