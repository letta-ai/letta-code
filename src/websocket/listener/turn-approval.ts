import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  type ApprovalResult,
  executeApprovalBatch,
} from "../../agent/approval-execution";
import { classifyApprovals } from "../../cli/helpers/approvalClassification";
import { computeDiffPreviews } from "../../helpers/diffPreview";
import { isInteractiveApprovalTool } from "../../tools/interactivePolicy";
import type {
  ApprovalResponseBody,
  ApprovalResponseDecision,
  ControlRequest,
} from "../../types/protocol_v2";
import {
  clearPendingApprovalBatchIds,
  collectApprovalResultToolCallIds,
  collectDecisionToolCallIds,
  rememberPendingApprovalBatchIds,
  requestApprovalOverWS,
  validateApprovalResultIds,
} from "./approval";
import {
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeExecutionResultsForInterruptParity,
  populateInterruptQueue,
} from "./interrupts";
import {
  emitDequeuedUserMessage,
  emitLoopErrorDelta,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { debugLogApprovalResumeState } from "./recovery";
import {
  markAwaitingAcceptedApprovalContinuationRunId,
  sendApprovalContinuationWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ConversationRuntime } from "./types";

type Decision =
  | {
      type: "approve";
      approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      };
      reason?: string;
    }
  | {
      type: "deny";
      approval: {
        toolCallId: string;
        toolName: string;
        toolArgs: string;
      };
      reason: string;
    };

export type ApprovalBranchResult = {
  terminated: boolean;
  stream: Stream<LettaStreamingResponse> | null;
  currentInput: Array<MessageCreate | ApprovalCreate>;
  dequeuedBatchId: string;
  pendingNormalizationInterruptedToolCallIds: string[];
  turnToolContextId: string | null;
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  lastApprovalContinuationAccepted: boolean;
};

export async function handleApprovalStop(params: {
  approvals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>;
  runtime: ConversationRuntime;
  socket: WebSocket;
  agentId: string;
  conversationId: string;
  turnWorkingDirectory: string;
  turnPermissionModeState: import("../../tools/manager").PermissionModeState;
  dequeuedBatchId: string;
  runId?: string;
  msgRunIds: string[];
  currentInput: Array<MessageCreate | ApprovalCreate>;
  pendingNormalizationInterruptedToolCallIds: string[];
  turnToolContextId: string | null;
  buildSendOptions: () => Parameters<
    typeof sendApprovalContinuationWithRetry
  >[2];
}): Promise<ApprovalBranchResult> {
  const {
    approvals,
    runtime,
    socket,
    agentId,
    conversationId,
    turnWorkingDirectory,
    turnPermissionModeState,
    dequeuedBatchId,
    runId,
    msgRunIds,
    currentInput,
    turnToolContextId,
    buildSendOptions,
  } = params;
  const abortController = runtime.activeAbortController;

  if (!abortController) {
    throw new Error("Missing active abort controller during approval handling");
  }

  if (approvals.length === 0) {
    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    setLoopStatus(runtime, "WAITING_ON_INPUT", {
      agent_id: agentId,
      conversation_id: conversationId,
    });
    runtime.activeWorkingDirectory = null;
    runtime.activeRunId = null;
    runtime.activeRunStartedAt = null;
    runtime.activeAbortController = null;
    emitRuntimeStateUpdates(runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    emitLoopErrorDelta(socket, runtime, {
      message: "requires_approval stop returned no approvals",
      stopReason: "error",
      isTerminal: true,
      agentId,
      conversationId,
    });
    return {
      terminated: true,
      stream: null,
      currentInput,
      dequeuedBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      lastApprovalContinuationAccepted: false,
    };
  }

  clearPendingApprovalBatchIds(runtime, approvals);
  rememberPendingApprovalBatchIds(runtime, approvals, dequeuedBatchId);

  const { autoAllowed, autoDenied, needsUserInput } = await classifyApprovals(
    approvals,
    {
      alwaysRequiresUserInput: isInteractiveApprovalTool,
      treatAskAsDeny: false,
      requireArgsForAutoApprove: true,
      missingNameReason: "Tool call incomplete - missing name",
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
    },
  );

  const lastNeedsUserInputToolCallIds = needsUserInput.map(
    (ac) => ac.approval.toolCallId,
  );
  let lastExecutionResults: ApprovalResult[] | null = null;
  let lastExecutingToolCallIds: string[] = [];

  const shouldInterrupt = () =>
    abortController.signal.aborted || runtime.cancelRequested;

  const interruptTermination = (
    interruptedInput: Array<MessageCreate | ApprovalCreate> = currentInput,
    interruptedBatchId: string = dequeuedBatchId,
  ): ApprovalBranchResult => {
    populateInterruptQueue(runtime, {
      lastExecutionResults,
      lastExecutingToolCallIds,
      lastNeedsUserInputToolCallIds,
      agentId: agentId || "",
      conversationId,
    });
    return {
      terminated: true,
      stream: null,
      currentInput: interruptedInput,
      dequeuedBatchId: interruptedBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults,
      lastExecutingToolCallIds,
      lastNeedsUserInputToolCallIds,
      lastApprovalContinuationAccepted: false,
    };
  };

  const decisions: Decision[] = [
    ...autoAllowed.map((ac) => ({
      type: "approve" as const,
      approval: ac.approval,
    })),
    ...autoDenied.map((ac) => ({
      type: "deny" as const,
      approval: ac.approval,
      reason: ac.denyReason || ac.permission.reason || "Permission denied",
    })),
  ];

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  if (needsUserInput.length > 0) {
    if (shouldInterrupt()) {
      return interruptTermination();
    }

    runtime.lastStopReason = "requires_approval";
    setLoopStatus(runtime, "WAITING_ON_APPROVAL", {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    for (const ac of needsUserInput) {
      if (shouldInterrupt()) {
        return interruptTermination();
      }

      const requestId = `perm-${ac.approval.toolCallId}`;
      const diffs = await computeDiffPreviews(
        ac.approval.toolName,
        ac.parsedArgs,
        turnWorkingDirectory,
      );
      if (shouldInterrupt()) {
        return interruptTermination();
      }
      const controlRequest: ControlRequest = {
        type: "control_request",
        request_id: requestId,
        request: {
          subtype: "can_use_tool",
          tool_name: ac.approval.toolName,
          input: ac.parsedArgs,
          tool_call_id: ac.approval.toolCallId,
          permission_suggestions: [],
          blocked_path: null,
          ...(diffs.length > 0 ? { diffs } : {}),
        },
        agent_id: agentId,
        conversation_id: conversationId,
      };

      let responseBody: ApprovalResponseBody;
      try {
        responseBody = await requestApprovalOverWS(
          runtime,
          socket,
          requestId,
          controlRequest,
        );
      } catch (error) {
        if (shouldInterrupt()) {
          return interruptTermination();
        }
        throw error;
      }

      if (shouldInterrupt()) {
        return interruptTermination();
      }

      if ("decision" in responseBody) {
        const response = responseBody.decision as ApprovalResponseDecision;
        if (response.behavior === "allow") {
          const finalApproval = response.updated_input
            ? {
                ...ac.approval,
                toolArgs: JSON.stringify(response.updated_input),
              }
            : ac.approval;
          decisions.push({
            type: "approve",
            approval: finalApproval,
            reason: response.message,
          });
        } else {
          decisions.push({
            type: "deny",
            approval: ac.approval,
            reason: response?.message || "Denied via WebSocket",
          });
        }
      } else {
        decisions.push({
          type: "deny",
          approval: ac.approval,
          reason: responseBody.error,
        });
      }
    }
  }

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  lastExecutingToolCallIds = decisions
    .filter(
      (decision): decision is Extract<Decision, { type: "approve" }> =>
        decision.type === "approve",
    )
    .map((decision) => decision.approval.toolCallId);
  runtime.activeExecutingToolCallIds = [...lastExecutingToolCallIds];
  setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  emitRuntimeStateUpdates(runtime, {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  const executionRunId =
    runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];
  emitToolExecutionStartedEvents(socket, runtime, {
    toolCallIds: lastExecutingToolCallIds,
    runId: executionRunId,
    agentId,
    conversationId,
  });

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  const executionResults = await executeApprovalBatch(decisions, undefined, {
    toolContextId: turnToolContextId ?? undefined,
    abortSignal: abortController.signal,
    workingDirectory: turnWorkingDirectory,
    parentScope:
      agentId && conversationId ? { agentId, conversationId } : undefined,
  });
  const persistedExecutionResults = normalizeExecutionResultsForInterruptParity(
    runtime,
    executionResults,
    lastExecutingToolCallIds,
  );
  validateApprovalResultIds(
    decisions.map((decision) => ({
      approval: {
        toolCallId: decision.approval.toolCallId,
      },
    })),
    persistedExecutionResults,
  );
  emitToolExecutionFinishedEvents(socket, runtime, {
    approvals: persistedExecutionResults,
    runId: executionRunId,
    agentId,
    conversationId,
  });
  lastExecutionResults = persistedExecutionResults;
  emitInterruptToolReturnMessage(
    socket,
    runtime,
    persistedExecutionResults,
    runtime.activeRunId ||
      runId ||
      msgRunIds[msgRunIds.length - 1] ||
      undefined,
    "tool-return",
  );

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  const nextInput: Array<MessageCreate | ApprovalCreate> = [
    {
      type: "approval",
      approvals: persistedExecutionResults,
    },
  ];
  let continuationBatchId = dequeuedBatchId;
  const consumedQueuedTurn = consumeQueuedTurn(runtime);
  if (consumedQueuedTurn) {
    const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
    continuationBatchId = dequeuedBatch.batchId;
    nextInput.push(...queuedTurn.messages);
    emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
  }

  const nextInputWithSkillContent = injectQueuedSkillContent(nextInput);

  if (shouldInterrupt()) {
    return interruptTermination(nextInputWithSkillContent, continuationBatchId);
  }

  setLoopStatus(runtime, "SENDING_API_REQUEST", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  let stream: Stream<LettaStreamingResponse> | null;
  try {
    stream = await sendApprovalContinuationWithRetry(
      conversationId,
      nextInputWithSkillContent,
      buildSendOptions(),
      socket,
      runtime,
      abortController.signal,
    );
  } catch (error) {
    if (shouldInterrupt()) {
      return interruptTermination(
        nextInputWithSkillContent,
        continuationBatchId,
      );
    }
    throw error;
  }
  if (!stream) {
    return {
      terminated: true,
      stream: null,
      currentInput: nextInputWithSkillContent,
      dequeuedBatchId: continuationBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults,
      lastExecutingToolCallIds,
      lastNeedsUserInputToolCallIds,
      lastApprovalContinuationAccepted: false,
    };
  }

  clearPendingApprovalBatchIds(
    runtime,
    decisions.map((decision) => decision.approval),
  );
  await debugLogApprovalResumeState(runtime, {
    agentId,
    conversationId,
    expectedToolCallIds: collectDecisionToolCallIds(
      decisions.map((decision) => ({
        approval: {
          toolCallId: decision.approval.toolCallId,
        },
      })),
    ),
    sentToolCallIds: collectApprovalResultToolCallIds(
      persistedExecutionResults,
    ),
  });
  markAwaitingAcceptedApprovalContinuationRunId(runtime, nextInput);
  setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  runtime.activeExecutingToolCallIds = [];
  emitRuntimeStateUpdates(runtime, {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  return {
    terminated: false,
    stream,
    currentInput: nextInputWithSkillContent,
    dequeuedBatchId: continuationBatchId,
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    lastExecutionResults,
    lastExecutingToolCallIds,
    lastNeedsUserInputToolCallIds,
    lastApprovalContinuationAccepted: true,
  };
}
