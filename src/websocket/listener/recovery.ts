import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import {
  getResumeDataFromBackend,
  type ResumeData,
} from "@/agent/check-approval";
import {
  buildFreshDenialApprovals,
  isApprovalPendingError,
  isInvalidToolCallIdsError,
  normalizeStreamErrorTypeToStopReason,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
  shouldRetryPostStreamRunError,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { createChannelTurnProgressBuilder } from "@/channels/progress";
import { getChannelRegistry } from "@/channels/registry";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import { formatPermissionDenial } from "@/permissions/format-denial";
import { isInteractiveApprovalTool } from "@/tools/interactive-policy";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import type {
  ApprovalResponseBody,
  StopReasonType,
  StreamDelta,
} from "@/types/protocol_v2";
import {
  applySuggestedPermissionsForApproval,
  classifyApprovalsWithSuggestions,
} from "./approval-suggestions";
import { MAX_POST_STOP_APPROVAL_RECOVERY } from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  createToolExecutionOutputEmitter,
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeToolReturnWireMessage,
} from "./interrupts";
import { ensureListenerModAdapter } from "./mod-adapter";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  emitCanonicalMessageDelta,
  emitDequeuedUserMessage,
  emitInterruptedStatusDelta,
  emitLoopStatusUpdate,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import { consumeQueuedTurn, resolveTurnLifecycleTerminal } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import {
  clearActiveRunState,
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import type { ListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  RecoveredPendingApproval,
} from "./types";

export function isApprovalToolCallDesyncError(detail: unknown): boolean {
  return isInvalidToolCallIdsError(detail) || isApprovalPendingError(detail);
}

export function getApprovalToolCallDesyncErrorText(errorInfo: {
  detail?: unknown;
  message?: unknown;
}): string | null {
  const detail = errorInfo.detail;
  if (typeof detail === "string" && isApprovalToolCallDesyncError(detail)) {
    return detail;
  }
  const message = errorInfo.message;
  if (typeof message === "string" && isApprovalToolCallDesyncError(message)) {
    return message;
  }
  return null;
}

function isBackendNotFoundError(error: unknown): boolean {
  return (
    (error instanceof APIError &&
      (error.status === 404 || error.status === 422)) ||
    (error instanceof Error && error.name === "LocalBackendNotFoundError")
  );
}

export function shouldAttemptPostStopApprovalRecovery(params: {
  stopReason: string | null | undefined;
  runIdsSeen: number;
  retries: number;
  runErrorDetail: string | null;
  latestErrorText: string | null;
  fallbackError?: string | null;
}): boolean {
  const approvalDesyncDetected =
    isApprovalToolCallDesyncError(params.runErrorDetail) ||
    isApprovalToolCallDesyncError(params.latestErrorText) ||
    isApprovalToolCallDesyncError(params.fallbackError);

  return shouldAttemptApprovalRecovery({
    approvalPendingDetected: approvalDesyncDetected,
    retries: params.retries,
    maxRetries: MAX_POST_STOP_APPROVAL_RECOVERY,
  });
}

export async function isRetriablePostStopError(
  stopReason: StopReasonType,
  lastRunId: string | null | undefined,
  fallbackDetail?: string | null,
): Promise<boolean> {
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
    return shouldRetryPostStreamRunError({
      stopReason,
      detail: fallbackDetail,
    });
  }

  try {
    const run = await getBackend().retrieveRun(lastRunId);
    const metaError = run.metadata?.error as
      | {
          error_type?: string;
          detail?: string;
          retryable?: boolean;
          error?: {
            error_type?: string;
            detail?: string;
            retryable?: boolean;
          };
        }
      | undefined;

    const errorType = metaError?.error_type ?? metaError?.error?.error_type;
    const detail = metaError?.detail ?? metaError?.error?.detail;
    const retryable = metaError?.retryable ?? metaError?.error?.retryable;
    return shouldRetryPostStreamRunError({
      stopReason,
      errorType,
      detail,
      retryable,
    });
  } catch {
    return shouldRetryPostStreamRunError({
      stopReason,
      detail: fallbackDetail,
    });
  }
}

export async function drainRecoveryStreamWithEmission(
  recoveryStream: Stream<LettaStreamingResponse>,
  socket: ListenerTransport,
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
          stopReason: normalizeStreamErrorTypeToStopReason(
            errorInfo.error_type,
          ),
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
  socket: ListenerTransport,
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
    const backend = getBackend();
    const agent = await backend.retrieveAgent(params.agentId);
    const isExplicitConversation =
      params.conversationId.length > 0 && params.conversationId !== "default";
    const lastInContextId = isExplicitConversation
      ? ((
          await backend.retrieveConversation(params.conversationId)
        ).in_context_message_ids?.at(-1) ?? null)
      : (agent.message_ids?.at(-1) ?? null);
    const lastInContextMessages = lastInContextId
      ? await backend.retrieveMessage(lastInContextId)
      : [];
    const resumeData = await getResumeDataFromBackend(
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
      reason: formatPermissionDenial(ac.permission, ac.denyReason),
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

  const backend = getBackend();
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
    resumeData = await getResumeDataFromBackend(agent, scope.conversation_id, {
      includeMessageHistory: false,
    });
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
}

export async function resolveRecoveredApprovalResponse(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  response: ApprovalResponseBody,
  processTurn: (
    msg: IncomingMessage,
    socket: ListenerTransport,
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
  if (!recovered?.approvalsByRequestId.has(requestId)) {
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
          agentId: recovered.agentId,
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
  const approvedDecisions = decisions.filter(
    (decision): decision is Extract<ApprovalDecision, { type: "approve" }> =>
      decision.type === "approve",
  );
  const approvedToolCallIds = approvedDecisions.map(
    (decision) => decision.approval.toolCallId,
  );

  if (
    (!runtime.activeChannelTurnSources ||
      runtime.activeChannelTurnSources.length === 0) &&
    recovered.agentId
  ) {
    const recoveredSources =
      getChannelRegistry()?.resolveTurnSourcesForScope(
        recovered.agentId,
        recovered.conversationId,
      ) ?? [];
    if (recoveredSources.length > 0) {
      runtime.activeChannelTurnSources = recoveredSources;
      runtime.activeChannelTurnBatchId ??= `recovered-${requestId || crypto.randomUUID()}`;
      runtime.activeChannelTurnProgress = createChannelTurnProgressBuilder();
      runtime.activeChannelTurnContextRecovered = true;
    }
  }
  const shouldFinalizeRecoveredChannelTurn =
    runtime.activeChannelTurnContextRecovered === true;
  let shouldClearRecoveredChannelContext = false;

  recovered.pendingRequestIds.clear();
  emitRuntimeStateUpdates(runtime, scope);

  runtime.isProcessing = true;
  runtime.activeWorkingDirectory = workingDirectory;
  runtime.activeExecutingToolCallIds = [...approvedToolCallIds];
  setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", scope);
  emitRuntimeStateUpdates(runtime, scope);
  emitToolExecutionStartedEvents(socket, runtime, {
    toolCalls: approvedDecisions.map((decision) => ({
      toolCallId: decision.approval.toolCallId,
      toolName: decision.approval.toolName,
      toolArgs: decision.approval.toolArgs,
    })),
    runId: runtime.activeRunId ?? undefined,
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
  });
  const emitToolExecutionOutput = createToolExecutionOutputEmitter(
    socket,
    runtime,
    {
      runId: runtime.activeRunId ?? undefined,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    },
  );
  const recoveryAbortController = new AbortController();
  runtime.activeAbortController = recoveryAbortController;
  await ensureSecretsHydratedForAgent(runtime.listener, recovered.agentId);
  const preparedToolContext = await prepareToolExecutionContextForScope({
    agentId: recovered.agentId,
    conversationId: recovered.conversationId,
    workingDirectory: runtime.activeWorkingDirectory,
    permissionModeState: getOrCreateConversationPermissionModeStateRef(
      runtime.listener,
      recovered.agentId,
      recovered.conversationId,
    ),
    modEvents: ensureListenerModAdapter(runtime.listener).events,
    ...(runtime.skillSources !== null
      ? { skillSources: runtime.skillSources }
      : {}),
  });
  runtime.currentToolset = preparedToolContext.toolset;
  runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
  runtime.currentLoadedTools =
    preparedToolContext.preparedToolContext.loadedToolNames;
  try {
    let approvalResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
    try {
      approvalResults = await executeApprovalBatch(decisions, undefined, {
        abortSignal: recoveryAbortController.signal,
        onStreamingOutput: emitToolExecutionOutput,
        toolContextId: preparedToolContext.preparedToolContext.contextId,
        workingDirectory,
        parentScope:
          recovered.agentId && recovered.conversationId
            ? {
                agentId: recovered.agentId,
                conversationId: recovered.conversationId,
              }
            : undefined,
        channelTurnSources: runtime.activeChannelTurnSources ?? undefined,
      });
    } finally {
      emitToolExecutionOutput.flush();
    }

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
        otid: crypto.randomUUID(),
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

    if (shouldFinalizeRecoveredChannelTurn) {
      const terminal = resolveTurnLifecycleTerminal(
        runtime.lastStopReason,
        false,
      );
      if (terminal.stopReason !== "requires_approval") {
        const sources = runtime.activeChannelTurnSources ?? [];
        if (sources.length > 0) {
          await getChannelRegistry()?.dispatchTurnLifecycleEvent({
            type: "finished",
            batchId: runtime.activeChannelTurnBatchId ?? continuationBatchId,
            sources,
            outcome: terminal.outcome,
            stopReason: terminal.stopReason,
            ...(runtime.lastTerminalLoopErrorMessage
              ? { error: runtime.lastTerminalLoopErrorMessage }
              : {}),
            ...(runtime.lastTerminalLoopErrorRunId
              ? { runId: runtime.lastTerminalLoopErrorRunId }
              : {}),
          });
        }
        shouldClearRecoveredChannelContext = true;
      }
    }

    clearRecoveredApprovalState(runtime);
    return true;
  } catch (error) {
    if (shouldFinalizeRecoveredChannelTurn) {
      const terminal = resolveTurnLifecycleTerminal(
        runtime.lastStopReason,
        true,
      );
      const sources = runtime.activeChannelTurnSources ?? [];
      if (sources.length > 0) {
        await getChannelRegistry()?.dispatchTurnLifecycleEvent({
          type: "finished",
          batchId:
            runtime.activeChannelTurnBatchId ??
            `recovered-${requestId || crypto.randomUUID()}`,
          sources,
          outcome: terminal.outcome,
          stopReason: terminal.stopReason,
          error: error instanceof Error ? error.message : String(error),
          ...(runtime.lastTerminalLoopErrorRunId
            ? { runId: runtime.lastTerminalLoopErrorRunId }
            : {}),
        });
      }
      shouldClearRecoveredChannelContext = true;
    }
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
  } finally {
    if (shouldClearRecoveredChannelContext) {
      runtime.activeChannelTurnSources = null;
      runtime.activeChannelTurnBatchId = null;
      runtime.activeChannelTurnProgress = null;
      runtime.activeChannelTurnContextRecovered = false;
    }
  }
}
