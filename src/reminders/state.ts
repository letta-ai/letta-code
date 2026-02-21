import type { ContextTracker } from "../cli/helpers/contextTracker";
import type { PermissionMode } from "../permissions/mode";

const MAX_PENDING_INTERACTION_REMINDERS = 25;

export interface CommandIoReminder {
  input: string;
  output: string;
  success: boolean;
}

export interface ToolsetChangeReminder {
  source: string;
  previousToolset: string | null;
  newToolset: string | null;
  previousTools: string[];
  newTools: string[];
}

export interface SharedReminderState {
  hasSentAgentInfo: boolean;
  hasSentSessionContext: boolean;
  hasInjectedSkillsReminder: boolean;
  cachedSkillsReminder: string | null;
  skillPathById: Record<string, string>;
  lastNotifiedPermissionMode: PermissionMode | null;
  turnCount: number;
  pendingSkillsReinject: boolean;
  pendingReflectionTrigger: boolean;
  pendingCommandIoReminders: CommandIoReminder[];
  pendingToolsetChangeReminders: ToolsetChangeReminder[];
}

export function createSharedReminderState(): SharedReminderState {
  return {
    hasSentAgentInfo: false,
    hasSentSessionContext: false,
    hasInjectedSkillsReminder: false,
    cachedSkillsReminder: null,
    skillPathById: {},
    lastNotifiedPermissionMode: null,
    turnCount: 0,
    pendingSkillsReinject: false,
    pendingReflectionTrigger: false,
    pendingCommandIoReminders: [],
    pendingToolsetChangeReminders: [],
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

function pushBounded<T>(items: T[], entry: T): void {
  items.push(entry);
  if (items.length <= MAX_PENDING_INTERACTION_REMINDERS) {
    return;
  }
  items.splice(0, items.length - MAX_PENDING_INTERACTION_REMINDERS);
}

export function enqueueCommandIoReminder(
  state: SharedReminderState,
  reminder: CommandIoReminder,
): void {
  pushBounded(state.pendingCommandIoReminders, reminder);
}

export function enqueueToolsetChangeReminder(
  state: SharedReminderState,
  reminder: ToolsetChangeReminder,
): void {
  pushBounded(state.pendingToolsetChangeReminders, reminder);
}
