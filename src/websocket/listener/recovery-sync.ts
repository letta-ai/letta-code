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
