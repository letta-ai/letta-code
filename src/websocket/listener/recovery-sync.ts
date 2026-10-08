// Restart-time approval recovery: when a sync arrives and this process has no
// live approval state, consult the backend for pending approvals recorded in
// the conversation and rebuild what can be safely re-presented.

import { APIError } from "@letta-ai/letta-client/core/error";
import type { ApprovalDecision } from "@/agent/approval-execution";
import {
  getResumeDataFromBackend,
  type ResumeData,
} from "@/agent/check-approval";
import {
  buildFreshDenialApprovals,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/turn-recovery-policy";
import {
  parseAskUserQuestionNotif,
  parseAskUserQuestionReceipt,
} from "@/ask-user-question";
import { getBackend } from "@/backend";
import { canRecoverConversation } from "./recovery-ownership";
import {
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import type { ConversationRuntime } from "./types";

function isBackendNotFoundError(error: unknown): boolean {
  return (
    (error instanceof APIError &&
      (error.status === 404 || error.status === 422)) ||
    (error instanceof Error && error.name === "LocalBackendNotFoundError")
  );
}

export async function recoverApprovalStateForSync(
  runtime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  deps: Partial<{
    getBackend: typeof getBackend;
    getResumeDataFromBackend: typeof getResumeDataFromBackend;
  }> = {},
  opts: {
    /**
     * The sync came from this conversation's execution owner (see
     * `SyncCommand.resume_interrupted_turn`): stale denials may start a turn
     * now instead of waiting for this listener's next user message.
     */
    resumeInterruptedTurn?: boolean;
  } = {},
): Promise<"deferred" | undefined> {
  const resolvedDeps = {
    getBackend,
    getResumeDataFromBackend,
    ...deps,
  };
  if (!scope.agent_id) {
    clearRecoveredApprovalState(runtime);
    return;
  }
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const sameActiveScope =
    runtime.agentId === scope.agent_id &&
    runtime.conversationId === scope.conversation_id;

  if (sameActiveScope && runtime.turnLifecycle.kind !== "idle") {
    clearRecoveredApprovalState(runtime);
    return;
  }

  if (runtime.pendingApprovalResolvers.size > 0 && sameActiveScope) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  if (!(await canRecoverConversation(runtime))) {
    clearRecoveredApprovalState(runtime);
    return "deferred";
  }

  const backend = resolvedDeps.getBackend();
  let agent: Awaited<ReturnType<typeof backend.retrieveAgent>>;
  try {
    agent = await backend.retrieveAgent(scope.agent_id);
  } catch (error) {
    if (isBackendNotFoundError(error)) {
      clearRecoveredApprovalState(runtime);
      return;
    }
    throw error;
  }

  let resumeData: ResumeData;
  try {
    resumeData = await resolvedDeps.getResumeDataFromBackend(
      agent,
      scope.conversation_id,
      {
        includeMessageHistory: false,
      },
    );
  } catch (error) {
    if (isBackendNotFoundError(error)) {
      clearRecoveredApprovalState(runtime);
      return;
    }
    throw error;
  }

  const pendingApprovals = resumeData.pendingApprovals ?? [];
  if (pendingApprovals.length === 0) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  // Re-check liveness after the backend awaits: a turn or live approval that
  // started meanwhile owns this conversation's approval state.
  if (!(await canRecoverConversation(runtime))) return "deferred";
  if (
    hasInterruptedCacheForScope(runtime.listener, scope) ||
    (sameActiveScope &&
      (runtime.turnLifecycle.kind !== "idle" ||
        runtime.pendingApprovalResolvers.size > 0))
  ) {
    return;
  }

  // Interrupted calls become stale denials. An execution-owner sync resumes
  // them now; observer sync parks them for the next input without closing
  // calls that another process may still be executing.
  const staleDenialDecisions: ApprovalDecision[] = pendingApprovals.map(
    (approval) => ({
      type: "deny" as const,
      approval,
      reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    }),
  );

  if (!opts.resumeInterruptedTurn) {
    runtime.pendingInterruptedResults = buildFreshDenialApprovals(
      pendingApprovals,
      STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    );
    runtime.pendingInterruptedContext = {
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = null;
    clearRecoveredApprovalState(runtime);
    return;
  }

  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.recoveredApprovalState = {
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    autoDecisions: staleDenialDecisions,
    allApprovals: pendingApprovals,
  };
  return undefined;
}

/**
 * Reconcile the runtime's pending async question set against the backend
 * conversation state on sync. Answers/dismissals that arrived while this
 * listener was away remove IDs; open receipts still in context add IDs the
 * listener never registered (e.g. after a restart). In-memory IDs with no
 * backend evidence either way are retained.
 */
export async function recoverPendingAsyncQuestionsForSync(
  runtime: ConversationRuntime,
  scope: { agent_id: string | null; conversation_id: string },
  deps: Partial<{
    getBackend: typeof getBackend;
    getResumeDataFromBackend: typeof getResumeDataFromBackend;
  }> = {},
): Promise<"deferred" | undefined> {
  const resolvedDeps = {
    getBackend,
    getResumeDataFromBackend,
    ...deps,
  };
  if (!scope.agent_id) {
    return;
  }
  // The interrupted cache retains this listener's own execution state;
  // recovery would only race with the continuation that owns it.
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    return;
  }
  const sameActiveScope =
    runtime.agentId === scope.agent_id &&
    runtime.conversationId === scope.conversation_id;
  if (sameActiveScope && runtime.turnLifecycle.kind !== "idle") {
    return;
  }
  if (!(await canRecoverConversation(runtime))) {
    return "deferred";
  }

  const backend = resolvedDeps.getBackend();
  let agent: Awaited<ReturnType<typeof backend.retrieveAgent>>;
  try {
    agent = await backend.retrieveAgent(scope.agent_id);
  } catch (error) {
    if (isBackendNotFoundError(error)) {
      runtime.pendingAsyncQuestionToolCallIds.clear();
      return;
    }
    throw error;
  }

  let resumeData: ResumeData;
  try {
    resumeData = await resolvedDeps.getResumeDataFromBackend(
      agent,
      scope.conversation_id,
      {
        includeMessageHistory: true,
      },
    );
  } catch (error) {
    if (isBackendNotFoundError(error)) {
      runtime.pendingAsyncQuestionToolCallIds.clear();
      return;
    }
    throw error;
  }

  // Re-check liveness after the backend awaits before mutating the set.
  if (!(await canRecoverConversation(runtime))) return "deferred";
  if (hasInterruptedCacheForScope(runtime.listener, scope)) return;
  if (
    sameActiveScope &&
    (runtime.turnLifecycle.kind !== "idle" ||
      runtime.pendingApprovalResolvers.size > 0)
  ) {
    return;
  }

  const inContextIds = new Set(
    resumeData.conversation?.in_context_message_ids ?? [],
  );
  const answeredToolCallIds = new Set<string>();
  const openReceiptToolCallIds = new Set<string>();
  for (const message of resumeData.messageHistory) {
    if (message.message_type === "user_message") {
      const content = (message as { content?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(
            (part): part is { type: string; text: string } =>
              part !== null &&
              typeof part === "object" &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          )
          .map((part) => part.text)
          .join("\n");
      }
      for (const response of parseAskUserQuestionNotif(text)) {
        answeredToolCallIds.add(response.toolCallId);
      }
    } else if (message.message_type === "tool_return_message") {
      const toolReturnMessage = message as {
        id?: string;
        tool_returns?: Array<{
          status?: string;
          tool_call_id?: string;
          tool_return?: unknown;
        }>;
        tool_call_id?: string;
        tool_return?: unknown;
        status?: string;
      };
      const entries: Array<{
        status?: string;
        tool_call_id?: string;
        tool_return?: unknown;
      }> = [];
      if (Array.isArray(toolReturnMessage.tool_returns)) {
        entries.push(...toolReturnMessage.tool_returns);
      } else if (
        typeof toolReturnMessage.tool_call_id === "string" &&
        toolReturnMessage.tool_call_id
      ) {
        entries.push({
          status: toolReturnMessage.status,
          tool_call_id: toolReturnMessage.tool_call_id,
          tool_return: toolReturnMessage.tool_return,
        });
      }
      for (const entry of entries) {
        if (entry.status !== "success") continue;
        const receipt = parseAskUserQuestionReceipt(entry.tool_return);
        if (
          receipt &&
          receipt.toolCallId === entry.tool_call_id &&
          (inContextIds.size === 0 || inContextIds.has(message.id ?? ""))
        ) {
          openReceiptToolCallIds.add(receipt.toolCallId);
        }
      }
    }
  }

  for (const toolCallId of answeredToolCallIds) {
    runtime.pendingAsyncQuestionToolCallIds.delete(toolCallId);
  }
  for (const toolCallId of openReceiptToolCallIds) {
    runtime.pendingAsyncQuestionToolCallIds.add(toolCallId);
  }
  return undefined;
}
