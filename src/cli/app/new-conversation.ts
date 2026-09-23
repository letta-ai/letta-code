// Shared session conversation transitions — the /new flow and the queued
// conversation switch. Used by the /new command, the queued-action processor,
// and the mod conversation rotation handler so all callers rebind the session
// identically.

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { MutableRefObject } from "react";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getBackend } from "@/backend";
import {
  type ContextTracker,
  resetContextHistory,
} from "@/cli/helpers/context-tracker";
import type { ConversationSwitchContext } from "@/cli/helpers/conversation-switch-alert";
import type { ApprovalRequest } from "@/cli/helpers/stream";
import type { ModConversationCloseReason } from "@/cli/mods/types";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { runSessionStartHooks } from "@/hooks";
import { settingsManager } from "@/settings-manager";
import type { AppCommandRunner } from "./types";

export interface NewConversationSessionDeps {
  agentId: string;
  agentName: string | null;
  conversationIdRef: MutableRefObject<string>;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  sessionHooksRanRef: MutableRefObject<boolean>;
  sessionStartFeedbackRef: MutableRefObject<string[]>;
  setConversationIdAndRef: (nextConversationId: string) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  maybeCarryOverActiveConversationModel: (
    targetConversationId: string,
  ) => Promise<void>;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  runEndHooks: (reason?: ModConversationCloseReason) => Promise<void>;
  modAdapter: LocalModAdapter;
}

/** Create an empty conversation on the agent. */
export async function createFreshConversation(
  agentId: string,
  name?: string,
): Promise<string> {
  const conversation = await getBackend().createConversation({
    agent_id: agentId,
    ...(name && { summary: name }),
  });
  return conversation.id;
}

/**
 * Rebind the live session to a freshly created conversation: end the old
 * session's hooks, swap the conversation id, persist, reset context tracking,
 * and open the new session's hooks and mod events. Mirrors /new exactly.
 */
export async function bindFreshConversation(
  deps: NewConversationSessionDeps,
  options: { conversationId: string; name?: string },
): Promise<void> {
  const { conversationId, name } = options;
  const prevConversationId = deps.conversationIdRef.current;

  // Run SessionEnd hooks for current session before starting new one
  await deps.runEndHooks("new");

  deps.setConversationAutoTitleEligibility(!name);
  await deps.maybeCarryOverActiveConversationModel(conversationId);

  // Update conversationId state and ref together so the next turn
  // cannot observe a stale conversation handoff.
  deps.setConversationIdAndRef(conversationId);

  deps.pendingConversationSwitchRef.current = {
    origin: "new",
    conversationId,
    isDefault: false,
  };

  // Save the new session to settings
  settingsManager.persistSession(deps.agentId, conversationId);

  // Reset context tokens for new conversation
  resetContextHistory(deps.contextTrackerRef.current);

  // Ensure bootstrap reminders are re-injected for the new conversation.
  deps.resetBootstrapReminderState(true);

  // Re-run SessionStart hooks for new conversation
  deps.sessionHooksRanRef.current = false;
  runSessionStartHooks(
    true, // isNewSession
    deps.agentId,
    deps.agentName ?? undefined,
    conversationId,
  )
    .then((result) => {
      if (result.feedback.length > 0) {
        deps.sessionStartFeedbackRef.current = result.feedback;
      }
    })
    .catch(() => {});
  deps.sessionHooksRanRef.current = true;
  void deps.modAdapter.events.emit(
    "conversation_open",
    {
      agentId: deps.agentId,
      agentName: deps.agentName ?? null,
      conversationId,
      previousConversationId: prevConversationId ?? null,
      reason: "new",
    },
    deps.modAdapter.context,
  );
}

/** Dependencies for running a queued conversation switch from the processor. */
export interface QueuedConversationSwitchDeps {
  agentId: string;
  agentState: AgentState | null | undefined;
  currentConversationId: string;
  commandRunner: AppCommandRunner;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  pendingConversationSwitchRef: MutableRefObject<ConversationSwitchContext | null>;
  recoverRestoredPendingApprovals: (
    approvals: ApprovalRequest[],
    options?: { notifyOnManualApproval?: boolean },
  ) => Promise<void>;
  refreshDerived: () => void;
  resetBootstrapReminderState: (pendingConversationBootstrap?: boolean) => void;
  setCommandRunning: (value: boolean) => void;
  setConversationAutoTitleEligibility: (enabled: boolean) => void;
  setConversationIdAndRef: (nextConversationId: string) => void;
}

/**
 * Run a queued switch to an existing conversation (resume-selector flow),
 * with command-row feedback. Extracted from the AppCoordinator queued-action
 * processor; behavior is unchanged.
 */
export function runQueuedConversationSwitch(
  deps: QueuedConversationSwitchDeps,
  action: { conversationId: string; commandId?: string },
): void {
  const cmd = action.commandId
    ? deps.commandRunner.getHandle(action.commandId, "/resume")
    : deps.commandRunner.start(
        "/resume",
        "Processing queued conversation switch...",
      );
  cmd.update({
    output: "Processing queued conversation switch...",
    phase: "running",
  });

  // Execute the conversation switch asynchronously
  void (async () => {
    deps.setCommandRunning(true);
    try {
      if (action.conversationId === deps.currentConversationId) {
        cmd.finish("Already on this conversation", true);
      } else if (deps.agentState) {
        const resumeData = await getResumeDataFromBackend(
          deps.agentState,
          action.conversationId,
        );

        deps.setConversationIdAndRef(action.conversationId);
        deps.setConversationAutoTitleEligibility(false);

        deps.pendingConversationSwitchRef.current = {
          origin: "resume-selector",
          conversationId: action.conversationId,
          isDefault: action.conversationId === "default",
          messageCount: resumeData.messageHistory.length,
          messageHistory: resumeData.messageHistory,
        };

        settingsManager.persistSession(deps.agentId, action.conversationId);

        // Reset context tokens for new conversation
        resetContextHistory(deps.contextTrackerRef.current);
        deps.resetBootstrapReminderState();

        if (resumeData.pendingApprovals.length > 0) {
          await deps.recoverRestoredPendingApprovals(
            resumeData.pendingApprovals,
          );
        }

        cmd.finish(
          `Switched to conversation (${resumeData.messageHistory.length} messages)`,
          true,
        );
      }
    } catch (error) {
      cmd.fail(
        `Failed to switch conversation: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      deps.setCommandRunning(false);
      deps.refreshDerived();
    }
  })();
}
