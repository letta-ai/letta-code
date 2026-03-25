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
import type {
  ApprovalResponseBody,
  StopReasonType,
  StreamDelta,
} from "../../types/protocol_v2";
import { parseApprovalInput } from "./approval";
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
import {
  emitCanonicalMessageDelta,
  emitDequeuedUserMessage,
  emitInterruptedStatusDelta,
  emitLoopErrorDelta,
  emitLoopStatusUpdate,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
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
    return false;
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
    return false;
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
        emitLoopErrorDelta(socket, runtime, {
          message: errorInfo.message || "Stream error",
          stopReason: (errorInfo.error_type as StopReasonType) || "error",
          isTerminal: false,
          runId: runtime.activeRunId || errorInfo.run_id,
          agentId: params.agentId ?? undefined,
          conversationId: params.conversationId,
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
  emitLoopErrorDelta(socket, runtime, {
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

  const approvalsByRequestId = new Map<string, RecoveredPendingApproval>();
  await Promise.all(
    pendingApprovals.map(async (approval) => {
      const requestId = `perm-${approval.toolCallId}`;
      const input = parseApprovalInput(approval.toolArgs);
      const diffs = await computeDiffPreviews(
        approval.toolName,
        input,
        getConversationWorkingDirectory(
          runtime.listener,
          scope.agent_id,
          scope.conversation_id,
        ),
      );

      approvalsByRequestId.set(requestId, {
        approval,
        controlRequest: {
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: approval.toolName,
            input,
            tool_call_id: approval.toolCallId,
            permission_suggestions: [],
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

  if (recovered.pendingRequestIds.size > 0) {
    emitRuntimeStateUpdates(runtime, {
      agent_id: recovered.agentId,
      conversation_id: recovered.conversationId,
    });
    return true;
  }

  const decisions: ApprovalDecision[] = [];
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
  runtime.activeWorkingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    recovered.agentId,
    recovered.conversationId,
  );
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
  try {
    const approvalResults = await executeApprovalBatch(decisions, undefined, {
      abortSignal: recoveryAbortController.signal,
      workingDirectory: getConversationWorkingDirectory(
        runtime.listener,
        recovered.agentId,
        recovered.conversationId,
      ),
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
