import type { ContextTracker } from "@/cli/helpers/context-tracker";
import type { PermissionMode } from "@/permissions/mode";

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

export interface MemoryGitSyncReminder {
  text: string;
}

export type SessionContextReason =
  | "initial_attach"
  | "cwd_changed"
  | "post_compaction";

export interface SharedReminderState {
  hasSentAgentInfo: boolean;
  hasSentSessionContext: boolean;
  hasSentConversationBootstrap: boolean;
  pendingConversationBootstrap: boolean;
  hasSentSecretsInfo: boolean;
  pendingSecretsInfoRefresh: boolean;
  lastSentSecretNamesKey: string | null;
  lastNotifiedPermissionMode: PermissionMode | null;
  turnCount: number;
  pendingReflectionTrigger: boolean;
  pendingMemoryGitSyncReminders: MemoryGitSyncReminder[];
  pendingCommandIoReminders: CommandIoReminder[];
  pendingToolsetChangeReminders: ToolsetChangeReminder[];
  /** When set, the next session-context reminder uses this reason for its intro text. */
  pendingSessionContextReason?: SessionContextReason;
}

export function createSharedReminderState(): SharedReminderState {
  return {
    hasSentAgentInfo: false,
    hasSentSessionContext: false,
    hasSentConversationBootstrap: false,
    pendingConversationBootstrap: false,
    hasSentSecretsInfo: false,
    pendingSecretsInfoRefresh: false,
    lastSentSecretNamesKey: null,
    lastNotifiedPermissionMode: null,
    turnCount: 0,
    pendingReflectionTrigger: false,
    pendingMemoryGitSyncReminders: [],
    pendingCommandIoReminders: [],
    pendingToolsetChangeReminders: [],
  };
}

export function resetSharedReminderState(state: SharedReminderState): void {
  Object.assign(state, createSharedReminderState());
}

/**
 * Re-arm one-shot execution-context reminders that compaction can evict.
 * Preserve queued reminders and change-specific refresh state.
 */
export function markPostCompactionContextRemindersPending(
  state: SharedReminderState,
): void {
  state.hasSentAgentInfo = false;
  state.hasSentSessionContext = false;
  state.pendingSessionContextReason ??= "post_compaction";
  state.hasSentSecretsInfo = false;
  state.lastNotifiedPermissionMode = null;
}

export function syncReminderStateFromContextTracker(
  state: SharedReminderState,
  contextTracker: ContextTracker,
): void {
  if (contextTracker.pendingReflectionTrigger) {
    markPostCompactionContextRemindersPending(state);
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

export function enqueueMemoryGitSyncReminder(
  state: SharedReminderState,
  reminder: MemoryGitSyncReminder,
): void {
  pushBounded(state.pendingMemoryGitSyncReminders, reminder);
}

export function enqueueToolsetChangeReminder(
  state: SharedReminderState,
  reminder: ToolsetChangeReminder,
): void {
  pushBounded(state.pendingToolsetChangeReminders, reminder);
}

export function markSecretsInfoReminderPending(
  state: SharedReminderState,
): void {
  state.hasSentSecretsInfo = false;
  state.pendingSecretsInfoRefresh = true;
}
