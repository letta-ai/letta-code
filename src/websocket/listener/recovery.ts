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
import { createChannelTurnProgressBuilder } from "@/channels/progress-builder";
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
import {
  finishActiveChannelTurn,
  recoverActiveChannelTurn,
} from "./channel-turn-session";
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
  emitLoopStatusUpdate,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import {
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import type { ListenerTransport } from "./transport";
import type { TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";
import { finishListenerTurn } from "./turn-terminal";
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
    turnLease: TurnLease;
  },
): Promise<Awaited<ReturnType<typeof drainStreamWithResume>>> {
  let recoveryRunIdSent = false;

  return drainStreamWithResume(
    recoveryStream,
    createBuffers(params.agentId || ""),
    () => {},
    params.turnLease.signal,
    undefined,
    ({ chunk, shouldOutput, errorInfo }) => {
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      if (typeof maybeRunId === "string") {
        runtime.turnLifecycle.setRunId(params.turnLease, maybeRunId);
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
          abortSignal: params.turnLease.signal,
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
  turnLease: TurnLease,
  params: {
    drainResult: Awaited<ReturnType<typeof drainStreamWithResume>>;
    agentId?: string | null;
    conversationId: string;
  },
): ReturnType<typeof finishListenerTurn> {
  if (params.drainResult.stopReason === "end_turn") {
    return finishListenerTurn(runtime, turnLease, {
      stopReason: "end_turn",
      agentId: params.agentId,
      conversationId: params.conversationId,
    });
  }

  if (params.drainResult.stopReason === "cancelled") {
    return finishListenerTurn(runtime, turnLease, {
      stopReason: "cancelled",
      socket,
      runId: runtime.activeRunId,
      agentId: params.agentId ?? undefined,
      conversationId: params.conversationId,
    });
  }

  const terminalStopReason =
    (params.drainResult.stopReason as StopReasonType) || "error";
  const runId = runtime.activeRunId;
  const transition = finishListenerTurn(runtime, turnLease, {
    stopReason: terminalStopReason,
    agentId: params.agentId,
    conversationId: params.conversationId,
  });
  if (!transition.finished) {
    return transition;
  }
  emitLoopErrorNotice(socket, runtime, {
    message: `Recovery continuation ended unexpectedly: ${terminalStopReason}`,
    stopReason: terminalStopReason,
    isTerminal: true,
    runId: runId || undefined,
    agentId: params.agentId ?? undefined,
    conversationId: params.conversationId,
  });
  return transition;
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

  if (sameActiveScope && runtime.turnLifecycle.kind !== "idle") {
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
    existingTurnLease?: TurnLease,
  ) => Promise<void>,
  opts?: {
    onStatusChange?: (
      status: "idle" | "receiving" | "processing",
      connectionId: string,
    ) => void;
    connectionId?: string;
    dependencies?: {
      applySuggestedPermissions?: typeof applySuggestedPermissionsForApproval;
      classifyApprovals?: typeof classifyApprovalsWithSuggestions;
      ensureSecretsHydrated?: typeof ensureSecretsHydratedForAgent;
      prepareToolExecutionContext?: typeof prepareToolExecutionContextForScope;
      executeApprovalBatch?: typeof executeApprovalBatch;
    };
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
  const dependencies = opts?.dependencies;
  const applySuggestedPermissions =
    dependencies?.applySuggestedPermissions ??
    applySuggestedPermissionsForApproval;
  const classifyApprovals =
    dependencies?.classifyApprovals ?? classifyApprovalsWithSuggestions;
  const ensureSecretsHydrated =
    dependencies?.ensureSecretsHydrated ?? ensureSecretsHydratedForAgent;
  const prepareToolExecutionContext =
    dependencies?.prepareToolExecutionContext ??
    prepareToolExecutionContextForScope;
  const executeApprovals =
    dependencies?.executeApprovalBatch ?? executeApprovalBatch;

  const workingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    recovered.agentId,
    recovered.conversationId,
  );
  const scope = {
    agent_id: recovered.agentId,
    conversation_id: recovered.conversationId,
  } as const;
  const respondedEntry = recovered.approvalsByRequestId.get(requestId);
  let autoDecisionsToAppend: ApprovalDecision[] = [];
  const reclassifiedRequestIds = new Set<string>();
  if (
    respondedEntry &&
    "decision" in response &&
    response.decision.behavior === "allow"
  ) {
    const savedSuggestions = await applySuggestedPermissions({
      decision: response.decision,
      context: respondedEntry.approvalContext,
      workingDirectory,
    });

    if (
      runtime.recoveredApprovalState !== recovered ||
      !recovered.pendingRequestIds.has(requestId)
    ) {
      return true;
    }

    if (savedSuggestions && recovered.pendingRequestIds.size > 1) {
      const remainingRecoveredEntries = [...recovered.pendingRequestIds]
        .filter((id) => id !== requestId)
        .map((id) => recovered.approvalsByRequestId.get(id))
        .filter((entry): entry is RecoveredPendingApproval => !!entry);
      const reclassified = await classifyApprovals(
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
        autoDecisionsToAppend = buildRecoveredAutoDecisions(
          reclassified.autoAllowed,
          reclassified.autoDenied,
        );
        const reclassifiedToolCallIds = new Set(
          [...reclassified.autoAllowed, ...reclassified.autoDenied].map(
            (entry) => entry.approval.toolCallId,
          ),
        );
        for (const pendingId of recovered.pendingRequestIds) {
          if (pendingId === requestId) {
            continue;
          }
          const pendingEntry = recovered.approvalsByRequestId.get(pendingId);
          if (
            pendingEntry &&
            reclassifiedToolCallIds.has(pendingEntry.approval.toolCallId)
          ) {
            reclassifiedRequestIds.add(pendingId);
          }
        }
      }
    }
  }

  if (
    runtime.recoveredApprovalState !== recovered ||
    !recovered.pendingRequestIds.has(requestId)
  ) {
    return true;
  }
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    clearRecoveredApprovalState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return true;
  }

  const pendingRequestIdsAfterResponse = [
    ...recovered.pendingRequestIds,
  ].filter(
    (pendingId) =>
      pendingId !== requestId && !reclassifiedRequestIds.has(pendingId),
  );
  const recoveryLease =
    pendingRequestIdsAfterResponse.length === 0
      ? runtime.turnLifecycle.begin({
          origin: "approval_recovery",
          workingDirectory,
          initialStatus: "EXECUTING_CLIENT_SIDE_TOOL",
        })
      : null;
  let shouldFinalizeRecoveredChannelTurn = false;
  let continuationFinalized = false;

  try {
    recovered.responsesByRequestId.set(requestId, response);
    recovered.pendingRequestIds.delete(requestId);
    if (autoDecisionsToAppend.length > 0) {
      recovered.autoDecisions = [
        ...(recovered.autoDecisions ?? []),
        ...autoDecisionsToAppend,
      ];
    }
    for (const reclassifiedRequestId of reclassifiedRequestIds) {
      recovered.pendingRequestIds.delete(reclassifiedRequestId);
      recovered.approvalsByRequestId.delete(reclassifiedRequestId);
      recovered.responsesByRequestId.delete(reclassifiedRequestId);
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

    if (!recoveryLease) {
      throw new Error("Recovered approval continuation has no lifecycle lease");
    }
    const approvedDecisions = decisions.filter(
      (decision): decision is Extract<ApprovalDecision, { type: "approve" }> =>
        decision.type === "approve",
    );
    const approvedToolCallIds = approvedDecisions.map(
      (decision) => decision.approval.toolCallId,
    );

    const activeChannelTurn = runtime.activeChannelTurn;
    if (
      (!activeChannelTurn || activeChannelTurn.sources.length === 0) &&
      recovered.agentId
    ) {
      const recoveredSources =
        getChannelRegistry()?.resolveTurnSourcesForScope(
          recovered.agentId,
          recovered.conversationId,
        ) ?? [];
      if (recoveredSources.length > 0) {
        recoverActiveChannelTurn(runtime, {
          sources: recoveredSources,
          batchId:
            activeChannelTurn?.batchId ??
            `recovered-${requestId || crypto.randomUUID()}`,
          progress: createChannelTurnProgressBuilder(),
        });
      }
    }
    shouldFinalizeRecoveredChannelTurn =
      runtime.activeChannelTurn?.contextRecovered === true;

    runtime.turnLifecycle.setExecutingToolCallIds(
      recoveryLease,
      approvedToolCallIds,
    );
    recovered.pendingRequestIds.clear();
    emitRuntimeStateUpdates(runtime, scope);
    const executionRunId = runtime.activeRunId ?? undefined;
    const executionChannelTurnSources = runtime.activeChannelTurn?.sources;
    emitToolExecutionStartedEvents(socket, runtime, {
      toolCalls: approvedDecisions.map((decision) => ({
        toolCallId: decision.approval.toolCallId,
        toolName: decision.approval.toolName,
        toolArgs: decision.approval.toolArgs,
      })),
      runId: executionRunId,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    });
    const emitToolExecutionOutput = createToolExecutionOutputEmitter(
      socket,
      runtime,
      {
        runId: executionRunId,
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
        shouldEmit: () => runtime.turnLifecycle.isCurrent(recoveryLease),
      },
    );
    await ensureSecretsHydrated(runtime.listener, recovered.agentId);
    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
    }
    const preparedToolContext = await prepareToolExecutionContext({
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
      workingDirectory,
      permissionModeState: getOrCreateConversationPermissionModeStateRef(
        runtime.listener,
        recovered.agentId,
        recovered.conversationId,
      ),
      modEvents: ensureListenerModAdapter(runtime.listener).events,
    });
    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
    }
    runtime.currentToolset = preparedToolContext.toolset;
    runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
    runtime.currentLoadedTools =
      preparedToolContext.preparedToolContext.loadedToolNames;
    let approvalResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
    try {
      approvalResults = await executeApprovals(decisions, undefined, {
        abortSignal: recoveryLease.signal,
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
        channelTurnSources: executionChannelTurnSources,
      });
    } finally {
      emitToolExecutionOutput.flush();
    }
    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
    }

    emitToolExecutionFinishedEvents(socket, runtime, {
      approvals: approvalResults,
      runId: executionRunId,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    });
    emitInterruptToolReturnMessage(
      socket,
      runtime,
      approvalResults,
      executionRunId,
      "tool-return",
    );

    runtime.turnLifecycle.setExecutingToolCallIds(recoveryLease, []);
    setTurnLoopStatus(runtime, recoveryLease, "SENDING_API_REQUEST", scope);
    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
    }
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

    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
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
      recoveryLease,
    );

    if (runtime.turnLifecycle.isCurrent(recoveryLease)) {
      throw new Error("Recovered continuation returned without finalizing");
    }
    if (runtime.turnLifecycle.kind !== "idle") {
      return true;
    }
    continuationFinalized = true;

    if (shouldFinalizeRecoveredChannelTurn) {
      await finishActiveChannelTurn(runtime, {
        lastStopReason: runtime.lastStopReason,
        didThrow: false,
        error: runtime.lastTerminalLoopErrorMessage ?? undefined,
        runId: runtime.lastTerminalLoopErrorRunId ?? undefined,
        retainOnApproval: true,
      });
    }

    if (runtime.recoveredApprovalState === recovered) {
      clearRecoveredApprovalState(runtime);
    }
    return true;
  } catch (error) {
    if (!recoveryLease || continuationFinalized) {
      throw error;
    }
    if (!runtime.turnLifecycle.isCurrent(recoveryLease)) {
      return true;
    }
    if (shouldFinalizeRecoveredChannelTurn) {
      await finishActiveChannelTurn(runtime, {
        lastStopReason: runtime.lastStopReason,
        didThrow: true,
        error: error instanceof Error ? error.message : String(error),
        runId: runtime.lastTerminalLoopErrorRunId ?? undefined,
      });
    }
    if (runtime.recoveredApprovalState === recovered) {
      recovered.pendingRequestIds = new Set(
        recovered.approvalsByRequestId.keys(),
      );
      recovered.responsesByRequestId.clear();
    }
    finishListenerTurn(runtime, recoveryLease, {
      stopReason: recoveryLease.signal.aborted ? "cancelled" : "error",
      socket,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
    });
    throw error;
  }
}
