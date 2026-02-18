import type { ContextTracker } from "../cli/helpers/contextTracker";
import type { PermissionMode } from "../permissions/mode";

export interface SharedReminderState {
  hasSentSessionContext: boolean;
  hasInjectedSkillsReminder: boolean;
  cachedSkillsReminder: string | null;
  skillPathById: Record<string, string>;
  lastNotifiedPermissionMode: PermissionMode | null;
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
    lastNotifiedPermissionMode: null,
    turnCount: 0,
    pendingSkillsReinject: false,
    pendingReflectionTrigger: false,
  };
}

export function resetSharedReminderState(state: SharedReminderState): void {
  Object.assign(state, createSharedReminderState());
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
