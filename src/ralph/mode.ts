// src/ralph/mode.ts
// Ralph Wiggum mode state management
// Singleton pattern matching src/permissions/mode.ts

// Default completion promise inspired by The_Whole_Daisy's recommendations
// Source: X post 2008625420741341355
export const DEFAULT_COMPLETION_PROMISE =
  "The task is complete. All requirements have been implemented and verified working. " +
  "Any tests that were relevant have been run and are passing. The implementation is " +
  "clean and production-ready. I have not taken any shortcuts or faked anything to " +
  "meet these requirements.";

export type RalphState = {
  isActive: boolean;
  isYolo: boolean;
  originalPrompt: string;
  completionPromise: string | null; // null = no promise check (Claude Code style)
  maxIterations: number; // 0 = unlimited
  currentIteration: number;
};

// Use globalThis to ensure singleton across bundle
const RALPH_KEY = Symbol.for("@letta/ralphMode");

type GlobalWithRalph = typeof globalThis & {
  [RALPH_KEY]: RalphState;
};

function getDefaultState(): RalphState {
  return {
    isActive: false,
    isYolo: false,
    originalPrompt: "",
    completionPromise: null,
    maxIterations: 0,
    currentIteration: 0,
  };
}

function getGlobalState(): RalphState {
  const global = globalThis as GlobalWithRalph;
  if (!global[RALPH_KEY]) {
    global[RALPH_KEY] = getDefaultState();
  }
  return global[RALPH_KEY];
}

function setGlobalState(state: RalphState): void {
  const global = globalThis as GlobalWithRalph;
  global[RALPH_KEY] = state;
}

/**
 * Ralph Wiggum mode state manager.
 * Implements iterative development loops where the agent keeps working
 * until it outputs a completion promise.
 */
class RalphModeManager {
  /**
   * Activate Ralph mode with the given configuration.
   * @param prompt - The task prompt
   * @param completionPromise - Promise text to check for (null = no check, uses default if undefined)
   * @param maxIterations - Max iterations before auto-stop (0 = unlimited)
   * @param isYolo - Whether to bypass permissions
   */
  activate(
    prompt: string,
    completionPromise: string | null | undefined,
    maxIterations: number,
    isYolo: boolean,
  ): void {
    // If completionPromise is undefined, use default
    // If it's null or empty string, that means "no promise check" (Claude Code style)
    let resolvedPromise: string | null;
    if (completionPromise === undefined) {
      resolvedPromise = DEFAULT_COMPLETION_PROMISE;
    } else if (
      completionPromise === null ||
      completionPromise === "" ||
      completionPromise.toLowerCase() === "none"
    ) {
      resolvedPromise = null;
    } else {
      resolvedPromise = completionPromise;
    }

    setGlobalState({
      isActive: true,
      isYolo,
      originalPrompt: prompt,
      completionPromise: resolvedPromise,
      maxIterations,
      currentIteration: 1,
    });
  }

  /**
   * Deactivate Ralph mode and reset state.
   */
  deactivate(): void {
    setGlobalState(getDefaultState());
  }

  /**
   * Get current Ralph mode state.
   */
  getState(): RalphState {
    return getGlobalState();
  }

  /**
   * Increment the iteration counter.
   */
  incrementIteration(): void {
    const state = getGlobalState();
    setGlobalState({
      ...state,
      currentIteration: state.currentIteration + 1,
    });
  }

  /**
   * Check if the assistant's output contains the completion promise.
   * Uses regex to find <promise>...</promise> tags.
   * @param text - The assistant's output text
   * @returns true if promise was found and matches
   */
  checkForPromise(text: string): boolean {
    const state = getGlobalState();
    if (!state.completionPromise) return false;

    // Match <promise>...</promise> tags (case insensitive, handles multiline)
    const match = text.match(/<promise>([\s\S]*?)<\/promise>/i);
    if (!match || match[1] === undefined) return false;

    // Normalize whitespace and compare
    const promiseText = match[1].trim().replace(/\s+/g, " ");
    const expected = state.completionPromise.trim().replace(/\s+/g, " ");

    return promiseText === expected;
  }

  /**
   * Check if the loop should continue.
   * @returns true if active and under iteration limit
   */
  shouldContinue(): boolean {
    const state = getGlobalState();
    if (!state.isActive) return false;
    if (
      state.maxIterations > 0 &&
      state.currentIteration >= state.maxIterations
    ) {
      return false;
    }
    return true;
  }
}

// Singleton instance
export const ralphMode = new RalphModeManager();
