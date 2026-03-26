import type { ContextTracker } from "../cli/helpers/contextTracker";
import type { PermissionMode } from "../permissions/mode";

const MAX_PENDING_INTERACTION_REMINDERS = 25;

export interface CommandIoReminder {
  input: string;
  output: string;
  success: boolean;
  /** Extra context appended only in the agent-facing reminder, not shown in the UI. */
  agentHint?: string;
}

export interface ToolsetChangeReminder {
  source: string;
  previousToolset: string | null;
  newToolset: string | null;
  previousTools: string[];
  newTools: string[];
}

export type SessionContextReason = "initial_attach" | "cwd_changed";

export interface SharedReminderState {
  hasSentAgentInfo: boolean;
  hasSentSessionContext: boolean;
  lastNotifiedPermissionMode: PermissionMode | null;
  turnCount: number;
  pendingReflectionTrigger: boolean;
  pendingAutoInitReminder: boolean;
  pendingCommandIoReminders: CommandIoReminder[];
  pendingToolsetChangeReminders: ToolsetChangeReminder[];
  /** When set, the next session-context reminder uses this reason for its intro text. */
  pendingSessionContextReason?: SessionContextReason;
}

export function createSharedReminderState(): SharedReminderState {
  return {
    hasSentAgentInfo: false,
    hasSentSessionContext: false,
    lastNotifiedPermissionMode: null,
    turnCount: 0,
    pendingReflectionTrigger: false,
    pendingAutoInitReminder: false,
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
