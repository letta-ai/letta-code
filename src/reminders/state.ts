import type { ContextTracker } from "../cli/helpers/contextTracker";

export interface SharedReminderState {
  hasSentSessionContext: boolean;
  hasInjectedSkillsReminder: boolean;
  cachedSkillsReminder: string | null;
  skillPathById: Record<string, string>;
  turnCount: number;
  pendingSkillsReinject: boolean;
  pendingReflectionTrigger: boolean;
}

export function createSharedReminderState(): SharedReminderState {
  return {
    hasSentSessionContext: false,
    hasInjectedSkillsReminder: false,
    cachedSkillsReminder: null,
    skillPathById: {},
    turnCount: 0,
    pendingSkillsReinject: false,
    pendingReflectionTrigger: false,
  };
}

export function resetSharedReminderState(state: SharedReminderState): void {
  state.hasSentSessionContext = false;
  state.hasInjectedSkillsReminder = false;
  state.cachedSkillsReminder = null;
  state.skillPathById = {};
  state.turnCount = 0;
  state.pendingSkillsReinject = false;
  state.pendingReflectionTrigger = false;
}

export function syncReminderStateFromContextTracker(
  state: SharedReminderState,
  contextTracker: ContextTracker,
): void {
  if (contextTracker.pendingSkillsReinject) {
    state.pendingSkillsReinject = true;
    contextTracker.pendingSkillsReinject = false;
  }
  if (contextTracker.pendingReflectionTrigger) {
    state.pendingReflectionTrigger = true;
    contextTracker.pendingReflectionTrigger = false;
  }
}
