import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "../../agent/approval-execution";
import { getResumeData } from "../../agent/check-approval";
import { getClient } from "../../agent/client";
import {
  isApprovalPendingError,
  isInvalidToolCallIdsError,
  shouldAttemptApprovalRecovery,
  shouldRetryRunMetadataError,
} from "../../agent/turn-recovery-policy";
import { createBuffers } from "../../cli/helpers/accumulator";
import { drainStreamWithResume } from "../../cli/helpers/stream";
import { computeDiffPreviews } from "../../helpers/diffPreview";
import { isInteractiveApprovalTool } from "../../tools/interactivePolicy";
import { prepareToolExecutionContextForScope } from "../../tools/toolset";
import type {
  ApprovalResponseBody,
  StopReasonType,
  StreamDelta,
} from "../../types/protocol_v2";
import {
  applySuggestedPermissionsForApproval,
  buildApprovalSuggestionPayload,
  classifyApprovalsWithSuggestions,
} from "./approval-suggestions";
import {
  MAX_POST_STOP_APPROVAL_RECOVERY,
  NO_AWAITING_APPROVAL_DETAIL_FRAGMENT,
} from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeToolReturnWireMessage,
} from "./interrupts";
import { getOrCreateConversationPermissionModeStateRef } from "./permissionMode";
import {
  emitCanonicalMessageDelta,
  emitDequeuedUserMessage,
  emitInterruptedStatusDelta,
  emitLoopStatusUpdate,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import {
  clearActiveRunState,
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import type {
  ConversationRuntime,
  IncomingMessage,
  RecoveredPendingApproval,
} from "./types";

export function isApprovalToolCallDesyncError(detail: unknown): boolean {
  if (isInvalidToolCallIdsError(detail) || isApprovalPendingError(detail)) {
    return true;
  }
  return (
    typeof detail === "string" &&
    detail.toLowerCase().includes(NO_AWAITING_APPROVAL_DETAIL_FRAGMENT)
  );
}

export function shouldAttemptPostStopApprovalRecovery(params: {
  stopReason: string | null | undefined;
  runIdsSeen: number;
  retries: number;
  runErrorDetail: string | null;
  latestErrorText: string | null;
}): boolean {
  const approvalDesyncDetected =
    isApprovalToolCallDesyncError(params.runErrorDetail) ||
    isApprovalToolCallDesyncError(params.latestErrorText);

  const genericNoRunError =
    params.stopReason === "error" && params.runIdsSeen === 0;

  return shouldAttemptApprovalRecovery({
    approvalPendingDetected: approvalDesyncDetected || genericNoRunError,
    retries: params.retries,
    maxRetries: MAX_POST_STOP_APPROVAL_RECOVERY,
  });
}

export async function isRetriablePostStopError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
  fallbackDetail?: string | null,
): Promise<boolean> {
  if (stopReason === "llm_api_error") {
    return true;
  }

  const nonRetriableReasons: StopReasonType[] = [
    "cancelled",
    "requires_approval",
    "max_steps",
    "max_tokens_exceeded",
    "context_window_overflow_in_system_prompt",
    "end_turn",
    "tool_rule",
    "no_tool_call",
  ];
  if (nonRetriableReasons.includes(stopReason)) {
    return false;
  }

  if (!lastRunId) {
    return shouldRetryRunMetadataError(undefined, fallbackDetail);
  }

  try {
    const client = await getClient();
    const run = await client.runs.retrieve(lastRunId);
    const metaError = run.metadata?.error as
      | {
          error_type?: string;
          detail?: string;
          error?: { error_type?: string; detail?: string };
        }
      | undefined;

    const errorType = metaError?.error_type ?? metaError?.error?.error_type;
    const detail = metaError?.detail ?? metaError?.error?.detail ?? "";
    return shouldRetryRunMetadataError(errorType, detail);
  } catch {
    return shouldRetryRunMetadataError(undefined, fallbackDetail);
  }
}

export async function drainRecoveryStreamWithEmission(
  recoveryStream: Stream<LettaStreamingResponse>,
  socket: WebSocket,
  runtime: ConversationRuntime,
  params: {
    agentId?: string | null;
    conversationId: string;
    abortSignal: AbortSignal;
  },
): Promise<Awaited<ReturnType<typeof drainStreamWithResume>>> {
  let recoveryRunIdSent = false;

  return drainStreamWithResume(
    recoveryStream,
    createBuffers(params.agentId || ""),
    () => {},
    params.abortSignal,
    undefined,
    ({ chunk, shouldOutput, errorInfo }) => {
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      if (typeof maybeRunId === "string") {
        if (runtime.activeRunId !== maybeRunId) {
          runtime.activeRunId = maybeRunId;
        }
        if (!recoveryRunIdSent) {
          recoveryRunIdSent = true;
          emitLoopStatusUpdate(socket, runtime, {
            agent_id: params.agentId ?? undefined,
            conversation_id: params.conversationId,
          });
        }
      }

      if (errorInfo) {
        emitLoopErrorNotice(socket, runtime, {
          message: errorInfo.message || "Stream error",
          stopReason: (errorInfo.error_type as StopReasonType) || "error",
          isTerminal: false,
          runId: runtime.activeRunId || errorInfo.run_id,
          agentId: params.agentId ?? undefined,
          conversationId: params.conversationId,
          errorInfo,
          abortSignal: params.abortSignal,
        });
      }

      if (shouldOutput) {
        const normalizedChunk = normalizeToolReturnWireMessage(
          chunk as unknown as Record<string, unknown>,
        );
        if (normalizedChunk) {
          emitCanonicalMessageDelta(
            socket,
            runtime,
            {
              ...normalizedChunk,
              type: "message",
            } as StreamDelta,
            {
              agent_id: params.agentId ?? undefined,
              conversation_id: params.conversationId,
            },
          );
        }
      }

      return undefined;
    },
  );
}

export function finalizeHandledRecoveryTurn(
  runtime: ConversationRuntime,
  socket: WebSocket,
  params: {
    drainResult: Awaited<ReturnType<typeof drainStreamWithResume>>;
    agentId?: string | null;
    conversationId: string;
  },
): void {
  const scope = {
    agent_id: params.agentId ?? null,
    conversation_id: params.conversationId,
  };

  if (params.drainResult.stopReason === "end_turn") {
    runtime.lastStopReason = "end_turn";
    runtime.isProcessing = false;
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return;
  }

  if (params.drainResult.stopReason === "cancelled") {
    runtime.lastStopReason = "cancelled";
    runtime.isProcessing = false;
    emitInterruptedStatusDelta(socket, runtime, {
      runId: runtime.activeRunId,
      agentId: params.agentId ?? undefined,
      conversationId: params.conversationId,
    });
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return;
  }

  const terminalStopReason =
    (params.drainResult.stopReason as StopReasonType) || "error";
  runtime.lastStopReason = terminalStopReason;
  runtime.isProcessing = false;
  setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
  const runId = runtime.activeRunId;
  clearActiveRunState(runtime);
  emitRuntimeStateUpdates(runtime, scope);
  emitLoopErrorNotice(socket, runtime, {
    message: `Recovery continuation ended unexpectedly: ${terminalStopReason}`,
    stopReason: terminalStopReason,
    isTerminal: true,
    runId: runId || undefined,
    agentId: params.agentId ?? undefined,
    conversationId: params.conversationId,
  });
}

export function getApprovalContinuationRecoveryDisposition(
  drainResult: Awaited<ReturnType<typeof drainStreamWithResume>> | null,
): "handled" | "retry" {
  return drainResult ? "handled" : "retry";
}

export async function debugLogApprovalResumeState(
  runtime: ConversationRuntime,
  params: {
    agentId: string;
    conversationId: string;
    expectedToolCallIds: string[];
    sentToolCallIds: string[];
  },
): Promise<void> {
  if (!process.env.DEBUG) {
    return;
  }

  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(params.agentId);
    const isExplicitConversation =
      params.conversationId.length > 0 && params.conversationId !== "default";
    const lastInContextId = isExplicitConversation
      ? ((
          await client.conversations.retrieve(params.conversationId)
        ).in_context_message_ids?.at(-1) ?? null)
      : (agent.message_ids?.at(-1) ?? null);
    const lastInContextMessages = lastInContextId
      ? await client.messages.retrieve(lastInContextId)
      : [];
    const resumeData = await getResumeData(
      client,
      agent,
      params.conversationId,
      {
        includeMessageHistory: false,
      },
    );

    console.log(
      "[Listen][DEBUG] Post-approval continuation resume snapshot",
      JSON.stringify(
        {
          conversationId: params.conversationId,
          activeRunId: runtime.activeRunId,
          expectedToolCallIds: params.expectedToolCallIds,
          sentToolCallIds: params.sentToolCallIds,
          pendingApprovalToolCallIds: (resumeData.pendingApprovals ?? []).map(
            (approval) => approval.toolCallId,
          ),
          lastInContextMessageId: lastInContextId,
          lastInContextMessageTypes: lastInContextMessages.map(
            (message) => message.message_type,
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.warn(
      "[Listen][DEBUG] Failed to capture post-approval resume snapshot:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function buildRecoveredAutoDecisions(
  autoAllowed: Awaited<
    ReturnType<typeof classifyApprovalsWithSuggestions>
  >["autoAllowed"],
  autoDenied: Awaited<
    ReturnType<typeof classifyApprovalsWithSuggestions>
  >["autoDenied"],
): ApprovalDecision[] {
  return [
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
}

export async function recoverApprovalStateForSync(
  runtime: ConversationRuntime,
  scope: { agent_id: string; conversation_id: string },
): Promise<void> {
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const sameActiveScope =
    runtime.agentId === scope.agent_id &&
    runtime.conversationId === scope.conversation_id;

  if (
    sameActiveScope &&
    (runtime.isProcessing || runtime.loopStatus !== "WAITING_ON_INPUT")
  ) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  if (runtime.pendingApprovalResolvers.size > 0 && sameActiveScope) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const client = await getClient();
  let agent: Awaited<ReturnType<typeof client.agents.retrieve>>;
  try {
    agent = await client.agents.retrieve(scope.agent_id);
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 422)
    ) {
      clearRecoveredApprovalState(runtime);
      return;
    }
    throw error;
  }

  let resumeData: Awaited<ReturnType<typeof getResumeData>>;
  try {
    resumeData = await getResumeData(client, agent, scope.conversation_id, {
      includeMessageHistory: false,
    });
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 404 || error.status === 422)
    ) {
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

  const workingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const permissionModeState = getOrCreateConversationPermissionModeStateRef(
    runtime.listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const { needsUserInput, autoAllowed, autoDenied } =
    await classifyApprovalsWithSuggestions(pendingApprovals, {
      alwaysRequiresUserInput: isInteractiveApprovalTool,
      requireArgsForAutoApprove: true,
      missingNameReason: "Tool call incomplete - missing name",
      workingDirectory,
      permissionModeState,
    });
  const autoDecisions = buildRecoveredAutoDecisions(autoAllowed, autoDenied);

  if (needsUserInput.length === 0) {
    clearRecoveredApprovalState(runtime);
    return;
  }

  const approvalsByRequestId = new Map<string, RecoveredPendingApproval>();
  await Promise.all(
    needsUserInput.map(async (approvalEntry) => {
      const approval = approvalEntry.approval;
      const requestId = `perm-${approval.toolCallId}`;
      const input = approvalEntry.parsedArgs;
      const diffs = await computeDiffPreviews(
        approval.toolName,
        input,
        workingDirectory,
      );

      approvalsByRequestId.set(requestId, {
        approval,
        approvalContext: approvalEntry.context,
        controlRequest: {
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: approval.toolName,
            input,
            tool_call_id: approval.toolCallId,
            ...buildApprovalSuggestionPayload(approvalEntry.context),
            blocked_path: null,
            ...(diffs.length > 0 ? { diffs } : {}),
          },
          agent_id: scope.agent_id,
          conversation_id: scope.conversation_id,
        },
      });
    }),
  );

  runtime.recoveredApprovalState = {
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    approvalsByRequestId,
    pendingRequestIds: new Set(approvalsByRequestId.keys()),
    responsesByRequestId: new Map(),
    autoDecisions,
    allApprovals: pendingApprovals,
  };
}

export async function resolveRecoveredApprovalResponse(
  runtime: ConversationRuntime,
  socket: WebSocket,
  response: ApprovalResponseBody,
  processTurn: (
    msg: IncomingMessage,
    socket: WebSocket,
    runtime: ConversationRuntime,
    onStatusChange?: (
      status: "idle" | "receiving" | "processing",
      connectionId: string,
    ) => void,
    connectionId?: string,
    dequeuedBatchId?: string,
  ) => Promise<void>,
  opts?: {
    onStatusChange?: (
      status: "idle" | "receiving" | "processing",
      connectionId: string,
    ) => void;
    connectionId?: string;
  },
): Promise<boolean> {
  const requestId = response.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return false;
  }

  const recovered = runtime.recoveredApprovalState;
  if (!recovered || !recovered.approvalsByRequestId.has(requestId)) {
    return false;
  }

  recovered.responsesByRequestId.set(requestId, response);
  recovered.pendingRequestIds.delete(requestId);
  const workingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    recovered.agentId,
    recovered.conversationId,
  );
  const respondedEntry = recovered.approvalsByRequestId.get(requestId);
  if (
    respondedEntry &&
    "decision" in response &&
    response.decision.behavior === "allow"
  ) {
    const savedSuggestions = await applySuggestedPermissionsForApproval({
      decision: response.decision,
      context: respondedEntry.approvalContext,
      workingDirectory,
    });

    if (savedSuggestions && recovered.pendingRequestIds.size > 0) {
      const remainingRecoveredEntries = [...recovered.pendingRequestIds]
        .map((id) => recovered.approvalsByRequestId.get(id))
        .filter((entry): entry is RecoveredPendingApproval => !!entry);
      const reclassified = await classifyApprovalsWithSuggestions(
        remainingRecoveredEntries.map((entry) => entry.approval),
        {
          alwaysRequiresUserInput: isInteractiveApprovalTool,
          requireArgsForAutoApprove: true,
          missingNameReason: "Tool call incomplete - missing name",
          workingDirectory,
          permissionModeState: getOrCreateConversationPermissionModeStateRef(
            runtime.listener,
            recovered.agentId,
            recovered.conversationId,
          ),
        },
      );

      if (
        reclassified.autoAllowed.length > 0 ||
        reclassified.autoDenied.length > 0
      ) {
        recovered.autoDecisions = [
          ...(recovered.autoDecisions ?? []),
          ...buildRecoveredAutoDecisions(
            reclassified.autoAllowed,
            reclassified.autoDenied,
          ),
        ];

        const reclassifiedToolCallIds = new Set(
          [...reclassified.autoAllowed, ...reclassified.autoDenied].map(
            (entry) => entry.approval.toolCallId,
          ),
        );
        for (const pendingId of [...recovered.pendingRequestIds]) {
          const pendingEntry = recovered.approvalsByRequestId.get(pendingId);
          if (
            pendingEntry &&
            reclassifiedToolCallIds.has(pendingEntry.approval.toolCallId)
          ) {
            recovered.pendingRequestIds.delete(pendingId);
            recovered.approvalsByRequestId.delete(pendingId);
            recovered.responsesByRequestId.delete(pendingId);
          }
        }
      }
    }
  }

  if (recovered.pendingRequestIds.size > 0) {
    emitRuntimeStateUpdates(runtime, {
      agent_id: recovered.agentId,
      conversation_id: recovered.conversationId,
    });
    return true;
  }

  const decisions: ApprovalDecision[] = [...(recovered.autoDecisions ?? [])];
  for (const [id, entry] of recovered.approvalsByRequestId) {
    const approvalResponse = recovered.responsesByRequestId.get(id);
    if (!approvalResponse) {
      continue;
    }

    if ("decision" in approvalResponse) {
      const decision = approvalResponse.decision;
      if (decision.behavior === "allow") {
        decisions.push({
          type: "approve",
          approval: decision.updated_input
            ? {
                ...entry.approval,
                toolArgs: JSON.stringify(decision.updated_input),
              }
            : entry.approval,
          reason: decision.message,
        });
      } else {
        decisions.push({
          type: "deny",
          approval: entry.approval,
          reason: decision.message || "Denied via WebSocket",
        });
      }
    } else {
      decisions.push({
        type: "deny",
        approval: entry.approval,
        reason: approvalResponse.error,
      });
    }
  }

  const scope = {
    agent_id: recovered.agentId,
    conversation_id: recovered.conversationId,
  } as const;
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    clearRecoveredApprovalState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return true;
  }
  const approvedToolCallIds = decisions
    .filter(
      (decision): decision is Extract<ApprovalDecision, { type: "approve" }> =>
        decision.type === "approve",
    )
    .map((decision) => decision.approval.toolCallId);

  recovered.pendingRequestIds.clear();
  emitRuntimeStateUpdates(runtime, scope);

  runtime.isProcessing = true;
  runtime.activeWorkingDirectory = workingDirectory;
  runtime.activeExecutingToolCallIds = [...approvedToolCallIds];
  setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", scope);
  emitRuntimeStateUpdates(runtime, scope);
  emitToolExecutionStartedEvents(socket, runtime, {
    toolCallIds: approvedToolCallIds,
    runId: runtime.activeRunId ?? undefined,
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
  });
  const recoveryAbortController = new AbortController();
  runtime.activeAbortController = recoveryAbortController;
  const preparedToolContext = await prepareToolExecutionContextForScope({
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
    workingDirectory: runtime.activeWorkingDirectory,
    permissionModeState: getOrCreateConversationPermissionModeStateRef(
      runtime.listener,
      recovered.agentId,
      recovered.conversationId,
    ),
  });
  runtime.currentToolset = preparedToolContext.toolset;
  runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
  runtime.currentLoadedTools =
    preparedToolContext.preparedToolContext.loadedToolNames;
  try {
    const approvalResults = await executeApprovalBatch(decisions, undefined, {
      abortSignal: recoveryAbortController.signal,
      toolContextId: preparedToolContext.preparedToolContext.contextId,
      workingDirectory,
      parentScope:
        recovered.agentId && recovered.conversationId
          ? {
              agentId: recovered.agentId,
              conversationId: recovered.conversationId,
            }
          : undefined,
    });

    emitToolExecutionFinishedEvents(socket, runtime, {
      approvals: approvalResults,
      runId: runtime.activeRunId ?? undefined,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    });
    emitInterruptToolReturnMessage(
      socket,
      runtime,
      approvalResults,
      runtime.activeRunId ?? undefined,
      "tool-return",
    );

    runtime.activeAbortController = null;
    setLoopStatus(runtime, "SENDING_API_REQUEST", scope);
    emitRuntimeStateUpdates(runtime, scope);

    const continuationMessages: Array<MessageCreate | ApprovalCreate> = [
      {
        type: "approval",
        approvals: approvalResults,
      },
    ];
    let continuationBatchId = `batch-recovered-${crypto.randomUUID()}`;
    const consumedQueuedTurn = consumeQueuedTurn(runtime);
    if (consumedQueuedTurn) {
      const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
      continuationBatchId = dequeuedBatch.batchId;
      continuationMessages.push(...queuedTurn.messages);
      emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
    }

    await processTurn(
      {
        type: "message",
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
        messages: continuationMessages,
      },
      socket,
      runtime,
      opts?.onStatusChange,
      opts?.connectionId,
      continuationBatchId,
    );

    clearRecoveredApprovalState(runtime);
    return true;
  } catch (error) {
    recovered.pendingRequestIds = new Set(
      recovered.approvalsByRequestId.keys(),
    );
    recovered.responsesByRequestId.clear();
    runtime.activeAbortController = null;
    runtime.isProcessing = false;
    runtime.activeExecutingToolCallIds = [];
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    clearActiveRunState(runtime);
    emitRuntimeStateUpdates(runtime, {
      agent_id: recovered.agentId,
      conversation_id: recovered.conversationId,
    });
    throw error;
  }
}
