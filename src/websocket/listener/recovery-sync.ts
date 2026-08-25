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
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import { isInteractiveApprovalTool } from "@/tools/interactive-policy";
import type { ControlRequest } from "@/types/protocol_v2";
import {
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import type { ConversationRuntime, RecoveredPendingApproval } from "./types";

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
): Promise<void> {
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

  // Keep in-flight recovered approvals: periodic syncs arrive every few
  // seconds, and rebuilding the state object while the user is mid-response
  // makes resolveRecoveredApprovalResponse drop the answer (it treats a
  // replaced state reference as ownership loss). It also avoids re-fetching
  // resume data on every sync while a recovered approval is displayed.
  const existingRecovered = runtime.recoveredApprovalState;
  if (
    existingRecovered &&
    existingRecovered.agentId === scope.agent_id &&
    existingRecovered.conversationId === scope.conversation_id &&
    existingRecovered.pendingRequestIds.size > 0
  ) {
    return;
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
  if (
    hasInterruptedCacheForScope(runtime.listener, scope) ||
    (sameActiveScope &&
      (runtime.turnLifecycle.kind !== "idle" ||
        runtime.pendingApprovalResolvers.size > 0))
  ) {
    return;
  }

  // Replay-unsafe tools (Bash, MessageChannel, ...) may already have run
  // before the process restarted, so they are never re-run or re-asked; they
  // become stale denials (#1876). Interactive tools (AskUserQuestion) carry
  // no client execution state — nothing ran and the question is fully
  // described by its arguments — so they are re-presented as live pending
  // control requests. Device status then broadcasts them again and observer
  // UIs can render the dialog after a restart.
  const interactivePending = pendingApprovals.filter((approval) =>
    isInteractiveApprovalTool(approval.toolName),
  );

  if (interactivePending.length === 0) {
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

  const staleDenialDecisions: ApprovalDecision[] = pendingApprovals
    .filter((approval) => !isInteractiveApprovalTool(approval.toolName))
    .map((approval) => ({
      type: "deny" as const,
      approval,
      reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    }));

  const approvalsByRequestId = new Map<string, RecoveredPendingApproval>();
  for (const approval of interactivePending) {
    const requestId = `perm-${approval.toolCallId}`;
    const controlRequest: ControlRequest = {
      type: "control_request",
      request_id: requestId,
      request: {
        subtype: "can_use_tool",
        tool_name: approval.toolName,
        input: safeJsonParseOr<Record<string, unknown>>(approval.toolArgs, {}),
        tool_call_id: approval.toolCallId,
        permission_suggestions: [],
        blocked_path: null,
      },
      agent_id: scope.agent_id,
      conversation_id: scope.conversation_id,
    };
    approvalsByRequestId.set(requestId, {
      approval,
      approvalContext: null,
      controlRequest,
    });
  }

  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.recoveredApprovalState = {
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    approvalsByRequestId,
    pendingRequestIds: new Set(approvalsByRequestId.keys()),
    responsesByRequestId: new Map(),
    autoDecisions: staleDenialDecisions,
    allApprovals: pendingApprovals,
  };
}
