import { readFile } from "node:fs/promises";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalResult,
  executeApprovalBatch,
} from "../../agent/approval-execution";
import { getChannelRegistry } from "../../channels/registry";
import type { ChannelTurnSource } from "../../channels/types";
import { computeDiffPreviews } from "../../helpers/diffPreview";
import { formatPermissionDenial } from "../../permissions/formatDenial";
import {
  getInteractiveApprovalKind,
  isInteractiveApprovalTool,
} from "../../tools/interactivePolicy";
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
  applySuggestedPermissionsForApproval,
  buildApprovalSuggestionPayload,
  classifyApprovalsWithSuggestions,
} from "./approval-suggestions";
import {
  createToolExecutionOutputEmitter,
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeExecutionResultsForInterruptParity,
  populateInterruptQueue,
} from "./interrupts";
import {
  emitDequeuedUserMessage,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { debugLogApprovalResumeState } from "./recovery";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import {
  markAwaitingAcceptedApprovalContinuationRunId,
  sendApprovalContinuationWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
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

function getChannelApprovalSourceScopeKey(source: ChannelTurnSource): string {
  return [
    source.channel,
    source.accountId ?? "",
    source.chatId,
    source.threadId ?? "",
  ].join(":");
}

export function resolveChannelApprovalSource(
  runtime: ConversationRuntime,
): ChannelTurnSource | null {
  const sources = runtime.activeChannelTurnSources ?? [];
  if (sources.length === 0) {
    return null;
  }

  const sourcesByScope = new Map<string, ChannelTurnSource>();
  for (const source of sources) {
    sourcesByScope.set(getChannelApprovalSourceScopeKey(source), source);
  }

  if (sourcesByScope.size !== 1) {
    return null;
  }

  return [...sourcesByScope.values()].at(-1) ?? null;
}

async function maybeReadPlanPreview(
  toolName: string,
  turnPermissionModeState: import("../../tools/manager").PermissionModeState,
): Promise<{ planFilePath?: string; planContent?: string }> {
  if (toolName !== "ExitPlanMode" || !turnPermissionModeState.planFilePath) {
    return {};
  }

  try {
    const planContent = await readFile(
      turnPermissionModeState.planFilePath,
      "utf8",
    );
    return {
      planFilePath: turnPermissionModeState.planFilePath,
      planContent,
    };
  } catch {
    return {
      planFilePath: turnPermissionModeState.planFilePath,
    };
  }
}

export async function handleApprovalStop(params: {
  approvals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>;
  runtime: ConversationRuntime;
  socket: ListenerTransport;
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

    emitLoopErrorNotice(socket, runtime, {
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

  const { autoAllowed, autoDenied, needsUserInput } =
    await classifyApprovalsWithSuggestions(approvals, {
      alwaysRequiresUserInput: isInteractiveApprovalTool,
      treatAskAsDeny: false,
      requireArgsForAutoApprove: true,
      missingNameReason: "Tool call incomplete - missing name",
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      agentId,
    });

  let pendingNeedsUserInput = [...needsUserInput];
  let lastNeedsUserInputToolCallIds = pendingNeedsUserInput.map(
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
      reason: formatPermissionDenial(ac.permission, ac.denyReason),
    })),
  ];

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  if (pendingNeedsUserInput.length > 0) {
    if (shouldInterrupt()) {
      return interruptTermination();
    }

    while (pendingNeedsUserInput.length > 0) {
      const ac = pendingNeedsUserInput.shift();
      if (!ac) {
        break;
      }

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
          ...buildApprovalSuggestionPayload(ac.context),
          blocked_path: null,
          ...(diffs.length > 0 ? { diffs } : {}),
        },
        agent_id: agentId,
        conversation_id: conversationId,
      };

      const registry = getChannelRegistry();
      const channelSource = resolveChannelApprovalSource(runtime);
      if (registry && channelSource) {
        await registry.registerPendingControlRequest({
          requestId,
          kind:
            getInteractiveApprovalKind(ac.approval.toolName) ??
            "generic_tool_approval",
          source: channelSource,
          toolName: ac.approval.toolName,
          input: ac.parsedArgs,
          ...(await maybeReadPlanPreview(
            ac.approval.toolName,
            turnPermissionModeState,
          )),
        });
      }

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
      } finally {
        registry?.clearPendingControlRequest(requestId);
      }

      if (shouldInterrupt()) {
        return interruptTermination();
      }

      if ("decision" in responseBody) {
        const response = responseBody.decision as ApprovalResponseDecision;
        if (response.behavior === "allow") {
          const savedSuggestions = await applySuggestedPermissionsForApproval({
            decision: response,
            context: ac.context,
            workingDirectory: turnWorkingDirectory,
          });
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

          if (savedSuggestions && pendingNeedsUserInput.length > 0) {
            const reclassified = await classifyApprovalsWithSuggestions(
              pendingNeedsUserInput.map((entry) => entry.approval),
              {
                alwaysRequiresUserInput: isInteractiveApprovalTool,
                treatAskAsDeny: false,
                requireArgsForAutoApprove: true,
                missingNameReason: "Tool call incomplete - missing name",
                workingDirectory: turnWorkingDirectory,
                permissionModeState: turnPermissionModeState,
                agentId,
              },
            );

            decisions.push(
              ...reclassified.autoAllowed.map((entry) => ({
                type: "approve" as const,
                approval: entry.approval,
              })),
              ...reclassified.autoDenied.map((entry) => ({
                type: "deny" as const,
                approval: entry.approval,
                reason: formatPermissionDenial(
                  entry.permission,
                  entry.denyReason,
                ),
              })),
            );
            pendingNeedsUserInput = [...reclassified.needsUserInput];
            lastNeedsUserInputToolCallIds = pendingNeedsUserInput.map(
              (entry) => entry.approval.toolCallId,
            );
          }
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
  const emitToolExecutionOutput = createToolExecutionOutputEmitter(
    socket,
    runtime,
    {
      runId: executionRunId,
      agentId,
      conversationId,
    },
  );

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  // Broadcast new file content to web clients when a file-mutating tool
  // (Edit, Write, MultiEdit) writes to disk, so all windows update immediately.
  const onFileWrite = (filePath: string, content: string) => {
    if (isListenerTransportOpen(socket)) {
      socket.send(
        JSON.stringify({
          type: "file_ops",
          path: filePath,
          cg_entries: [],
          ops: [],
          source: "agent",
          document_content: content,
        }),
      );
    }
  };

  let executionResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
  try {
    if (agentId) {
      await ensureSecretsHydratedForAgent(runtime.listener, agentId);
    }
    executionResults = await executeApprovalBatch(decisions, undefined, {
      toolContextId: turnToolContextId ?? undefined,
      abortSignal: abortController.signal,
      onStreamingOutput: emitToolExecutionOutput,
      workingDirectory: turnWorkingDirectory,
      parentScope:
        agentId && conversationId ? { agentId, conversationId } : undefined,
      onFileWrite,
    });
  } finally {
    emitToolExecutionOutput.flush();
  }
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
      otid: crypto.randomUUID(),
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
