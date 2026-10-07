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
import {
  allRecordedResults,
  createInterruptedTurnStore,
  readInterruptedTurn,
} from "./interrupted-turn-record";
import { getRecoveryEligibility } from "./recovery-ownership";
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
    readInterruptedTurn: typeof readInterruptedTurn;
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
    readInterruptedTurn,
    ...deps,
  };
  if (!scope.agent_id) {
    clearRecoveredApprovalState(runtime);
    return;
  }
  if (opts.resumeInterruptedTurn) {
    runtime.pendingInterruptedResults = null;
    runtime.pendingInterruptedContext = null;
    runtime.pendingInterruptedToolCallIds = null;
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

  const initialEligibility = await getRecoveryEligibility(runtime);
  if (initialEligibility !== "owned") {
    if (initialEligibility === "conflict") clearRecoveredApprovalState(runtime);
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
  if ((await getRecoveryEligibility(runtime)) !== "owned") return "deferred";
  if (
    hasInterruptedCacheForScope(runtime.listener, scope) ||
    (sameActiveScope &&
      (runtime.turnLifecycle.kind !== "idle" ||
        runtime.pendingApprovalResolvers.size > 0))
  ) {
    return;
  }

  const rawRecorded = resolvedDeps.readInterruptedTurn(runtime);
  const recorded =
    rawRecorded?.recoveryClaimCompletion?.independentSuccessor &&
    deps.readInterruptedTurn === undefined
      ? (createInterruptedTurnStore().readRecoveryView(
          rawRecorded.agentId,
          rawRecorded.conversationId,
          rawRecorded.recoveryClaimCompletion.lineageId,
        ) ?? rawRecorded)
      : rawRecorded;
  const recordedResults = new Map(
    (recorded ? allRecordedResults(recorded) : []).map((result) => [
      result.tool_call_id,
      result,
    ]),
  );
  // Local evidence distinguishes exact completed results, provably unstarted
  // approvals, and unrelated stale calls. Only the unstarted set executes again.
  const staleDenialDecisions: ApprovalDecision[] = pendingApprovals.map(
    (approval) => {
      const saved = recordedResults.get(approval.toolCallId);
      if (recorded?.toolCallIds.includes(approval.toolCallId)) {
        if (
          !saved &&
          recorded.unstartedToolCallIds?.includes(approval.toolCallId)
        ) {
          return { type: "approve" as const, approval };
        }
        if (!saved) {
          return {
            type: "deny" as const,
            approval,
            reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
          };
        }
        if (!("tool_return" in saved)) {
          return {
            type: "deny" as const,
            approval,
            reason: saved.reason ?? STALE_APPROVAL_RECOVERY_DENIAL_REASON,
          };
        }
        return {
          type: "approve" as const,
          approval,
          precomputedResult: {
            toolReturn: saved.tool_return,
            status: saved.status,
            stdout: saved.stdout ?? undefined,
            stderr: saved.stderr ?? undefined,
          },
        };
      }
      return {
        type: "deny" as const,
        approval,
        reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
      };
    },
  );

  if (!opts.resumeInterruptedTurn) {
    // An observer must not turn replayable or exactly completed work into stale
    // denials. Leave the durable record untouched so the execution owner can
    // perform the recovered continuation on its subsequent owner sync.
    if (staleDenialDecisions.some((decision) => decision.type === "approve")) {
      clearRecoveredApprovalState(runtime);
      return "deferred";
    }
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
    actingUserId: recorded?.actingUserId,
    autoDecisions: staleDenialDecisions,
    allApprovals: pendingApprovals,
    durableInputIdentities: recorded?.durableInputIdentities,
    terminalConsumerIds: recorded?.terminalConsumerIds,
    interruptedRevision: recorded?.revision,
    recoveryLineageId: recorded?.recoveryClaimCompletion?.lineageId,
    recoveryUsesIndependentSuccessor:
      recorded?.recoveryClaimCompletion?.independentSuccessor === true,
  };
  return undefined;
}
