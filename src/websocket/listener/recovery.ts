import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import {
  isApprovalPendingError,
  isInvalidToolCallIdsError,
  normalizeStreamErrorTypeToStopReason,
  shouldAttemptApprovalRecovery,
  shouldRetryPostStreamRunError,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import type { StopReasonType, StreamDelta } from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import { normalizeCloudRetryWireMessage } from "./cloud-retry-message";
import {
  findListenerConnectionByTransport,
  getSubscribedListenerConnections,
} from "./connection";
import {
  LISTENER_STREAM_RESUME_POLICY,
  MAX_POST_STOP_APPROVAL_RECOVERY,
} from "./constants";
import { appendQueuedTurnToInput } from "./continuation-input";
import { getConversationWorkingDirectory } from "./cwd";
import { completeInputReplay } from "./input-disposition";
import { recordListenerWork } from "./interrupted-turn-record";
import {
  createToolExecutionOutputEmitter,
  emitInterruptToolReturnMessage,
  emitToolExecutionAbortedEvents,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
} from "./interrupts";
import {
  createListenerAgentModContext,
  createListenerModEvents,
  ensureListenerModAdaptersForAgent,
} from "./mod-adapter";
import { awaitOrderedOutboundDeliveries } from "./outbound-delivery";
import { getOutboundQueueStats, OUTBOUND_QUEUE_LIMITS } from "./outbound-wire";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  emitCanonicalMessageDelta,
  emitDequeuedUserMessage,
  emitLoopStatusUpdate,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import {
  emitLoopErrorNotice,
  getTranscriptLoopErrorMessage,
} from "./recoverable-notices";
import { recoveredApprovalFailureResults } from "./recovered-approval-checkpoint";
import {
  acquireRecoveryClaim,
  canRecoverConversation,
  type RecoveryClaim,
} from "./recovery-ownership";
import {
  clearRecoveredApprovalState,
  hasInterruptedCacheForScope,
} from "./runtime";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
} from "./transport";
import {
  createTurnCorrelation,
  type TurnCorrelation,
} from "./turn-correlation";
import { createTurnInputState } from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";
import { finishListenerTurn } from "./turn-terminal";
import type { ConversationRuntime, IncomingMessage } from "./types";

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
    turnCorrelation?: TurnCorrelation;
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
      if (!runtime.turnLifecycle.isCurrent(params.turnLease)) {
        return undefined;
      }
      const maybeRunId = (chunk as { run_id?: unknown }).run_id;
      if (typeof maybeRunId === "string") {
        runtime.turnLifecycle.setRunId(params.turnLease, maybeRunId);
        params.turnCorrelation?.observeRun(maybeRunId);
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
        const normalizedChunk =
          normalizeCloudRetryWireMessage(chunk) ??
          normalizeToolReturnWireMessage(
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
    undefined,
    undefined,
    LISTENER_STREAM_RESUME_POLICY,
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
    turnId: string;
  },
): ReturnType<typeof finishListenerTurn> {
  if (params.drainResult.stopReason === "end_turn") {
    return finishListenerTurn(runtime, turnLease, {
      stopReason: "end_turn",
      socket,
      agentId: params.agentId,
      conversationId: params.conversationId,
      turnId: params.turnId,
    });
  }

  if (params.drainResult.stopReason === "cancelled") {
    return finishListenerTurn(runtime, turnLease, {
      stopReason: "cancelled",
      socket,
      runId: runtime.activeRunId,
      agentId: params.agentId ?? undefined,
      conversationId: params.conversationId,
      turnId: params.turnId,
    });
  }

  const terminalStopReason =
    (params.drainResult.stopReason as StopReasonType) || "error";
  const runId = runtime.activeRunId;
  const noticeParams = {
    message: `Recovery continuation ended unexpectedly: ${terminalStopReason}`,
    agentId: params.agentId,
    conversationId: params.conversationId,
  };
  const transition = finishListenerTurn(runtime, turnLease, {
    stopReason: terminalStopReason,
    socket,
    agentId: params.agentId,
    conversationId: params.conversationId,
    turnId: params.turnId,
    error: getTranscriptLoopErrorMessage(noticeParams),
  });
  if (!transition.finished) {
    return transition;
  }
  emitLoopErrorNotice(socket, runtime, {
    ...noticeParams,
    stopReason: terminalStopReason,
    isTerminal: true,
    runId: runId || undefined,
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
  if (!isDebugEnabled()) {
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

type RecoveredContinuationProcessTurn = (
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
  existingTurnCorrelation?: TurnCorrelation,
) => Promise<void>;

export type RecoveredContinuationDependencies = {
  ensureSecretsHydrated?: typeof ensureSecretsHydratedForAgent;
  ensureModAdapters?: typeof ensureListenerModAdaptersForAgent;
  prepareToolExecutionContext?: typeof prepareToolExecutionContextForScope;
  executeApprovalBatch?: typeof executeApprovalBatch;
  recordListenerWork?: typeof recordListenerWork;
  acquireRecoveryClaim?: typeof acquireRecoveryClaim;
};

type RecoveryDeliveryOrigin = {
  connectionId: string;
  connectionIdCanResume: boolean;
};

type RecoveredContinuationOptions = {
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void;
  connectionId?: string;
  dependencies?: RecoveredContinuationDependencies;
};

/**
 * Restart recovery found pending approvals. Finish the
 * interrupted turn now: send the stale denials as this conversation's next
 * turn so the model can re-issue the work, instead of parking them until a
 * user message happens to arrive. Returns false when the recovered state is
 * not in that shape or another owner holds the conversation.
 */
export async function startRecoveredApprovalContinuation(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  processTurn: RecoveredContinuationProcessTurn,
  opts?: RecoveredContinuationOptions,
): Promise<boolean> {
  const recovered = runtime.recoveredApprovalState;
  if (
    !recovered ||
    !recovered.autoDecisions ||
    recovered.autoDecisions.length === 0
  ) {
    return false;
  }
  if (runtime.turnLifecycle.kind !== "idle") {
    return false;
  }
  const originConnection = opts?.connectionId
    ? (runtime.listener.connections.get(opts.connectionId) ?? null)
    : findListenerConnectionByTransport(runtime.listener, socket);
  if (
    opts?.connectionId &&
    !originConnection &&
    getListenerTransportKind(socket) === "runtime"
  ) {
    if (runtime.activeConnectionId === opts.connectionId) {
      runtime.activeConnectionId = null;
    }
    return false;
  }
  const deliveryOrigin: RecoveryDeliveryOrigin | null = originConnection
    ? {
        connectionId: originConnection.id,
        connectionIdCanResume:
          originConnection.options.connectionIdCanResume !== false,
      }
    : null;
  if (!(await canRecoverConversation(runtime))) {
    if (runtime.recoveredApprovalState === recovered) {
      clearRecoveredApprovalState(runtime);
    }
    return false;
  }
  if (
    runtime.turnLifecycle.kind !== "idle" ||
    runtime.recoveredApprovalState !== recovered
  )
    return false;
  const scope = {
    agent_id: recovered.agentId,
    conversation_id: recovered.conversationId,
  } as const;
  if (hasInterruptedCacheForScope(runtime.listener, scope)) {
    clearRecoveredApprovalState(runtime);
    emitRuntimeStateUpdates(runtime, scope);
    return true;
  }

  const workingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    recovered.agentId,
    recovered.conversationId,
  );
  let recoveryLease: TurnLease | undefined;
  const acquireClaim =
    opts?.dependencies?.acquireRecoveryClaim ?? acquireRecoveryClaim;
  const recoveryClaim = await acquireClaim(runtime, () => {
    if (recoveryLease && runtime.turnLifecycle.isCurrent(recoveryLease)) {
      runtime.turnLifecycle.requestCancellation({ cause: "transport" });
    }
  });
  if (runtime.listener.connectionId?.startsWith("conn-") && !recoveryClaim) {
    return false;
  }
  if (
    runtime.turnLifecycle.kind !== "idle" ||
    runtime.recoveredApprovalState !== recovered
  ) {
    await recoveryClaim?.release();
    return false;
  }
  recoveryLease = runtime.turnLifecycle.begin({
    origin: "approval_recovery",
    workingDirectory,
    initialStatus: "EXECUTING_CLIENT_SIDE_TOOL",
  });
  await executeRecoveredApprovalContinuation({
    recoveryClaim,
    runtime,
    socket,
    recovered,
    decisions: [...recovered.autoDecisions],
    recoveryLease,
    workingDirectory,
    turnId: `batch-recovered-startup-${crypto.randomUUID()}`,
    processTurn,
    opts,
    deliveryOrigin,
  });
  return true;
}

async function executeRecoveredApprovalContinuation(params: {
  recoveryClaim: RecoveryClaim | null;
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  recovered: NonNullable<ConversationRuntime["recoveredApprovalState"]>;
  decisions: ApprovalDecision[];
  recoveryLease: TurnLease;
  workingDirectory: string;
  turnId: string;
  processTurn: RecoveredContinuationProcessTurn;
  opts?: RecoveredContinuationOptions;
  deliveryOrigin: RecoveryDeliveryOrigin | null;
}): Promise<void> {
  const {
    recoveryClaim,
    runtime,
    socket,
    recovered,
    decisions,
    recoveryLease,
    workingDirectory,
    turnId,
    processTurn,
    opts,
    deliveryOrigin,
  } = params;
  const dependencies = opts?.dependencies;
  const ensureSecretsHydrated =
    dependencies?.ensureSecretsHydrated ?? ensureSecretsHydratedForAgent;
  const ensureModAdapters =
    dependencies?.ensureModAdapters ?? ensureListenerModAdaptersForAgent;
  const prepareToolExecutionContext =
    dependencies?.prepareToolExecutionContext ??
    prepareToolExecutionContextForScope;
  const executeApprovals =
    dependencies?.executeApprovalBatch ?? executeApprovalBatch;
  const recordWork = dependencies?.recordListenerWork ?? recordListenerWork;
  const finishRecoveredTurn = (
    options: Parameters<typeof finishListenerTurn>[2],
  ) => {
    const transition = finishListenerTurn(runtime, recoveryLease, {
      ...options,
      terminalConsumerIds: recovered.terminalConsumerIds,
    });
    if (
      transition.finished &&
      !completeInputReplay(runtime, recovered.durableInputIdentities ?? [])
    ) {
      throw new Error("Failed to retire recovered accepted-input identities");
    }
    return transition;
  };
  const scope = {
    agent_id: recovered.agentId,
    conversation_id: recovered.conversationId,
  } as const;
  const originConnectionId = deliveryOrigin?.connectionId;
  const originConnectionCanResume =
    deliveryOrigin?.connectionIdCanResume ?? true;
  let selectedDeliveryOwnerId = originConnectionId;
  const hasRecoveryOwnership = () =>
    runtime.turnLifecycle.isCurrent(recoveryLease) &&
    (!recoveryClaim || recoveryClaim.owned);
  const shouldInterruptDelivery = () =>
    recoveryLease.signal.aborted || !hasRecoveryOwnership();
  const getDeliveryOwnerId = (): string | null => {
    if (
      originConnectionId &&
      (!runtime.activeConnectionId ||
        runtime.activeConnectionId === originConnectionId)
    ) {
      const directOrigin = runtime.listener.connections.get(originConnectionId);
      const directOriginTransport =
        directOrigin?.streamWriter ?? directOrigin?.writer;
      if (
        directOrigin?.initialized &&
        directOriginTransport &&
        isListenerTransportOpen(directOriginTransport) &&
        !getOutboundQueueStats(directOriginTransport).killed
      ) {
        selectedDeliveryOwnerId = originConnectionId;
        return originConnectionId;
      }
    }
    const subscribers = getSubscribedListenerConnections(
      runtime.listener,
      scope,
    ).filter(
      (connection) =>
        !getOutboundQueueStats(connection.streamWriter ?? connection.writer)
          .killed,
    );
    const preferred = runtime.activeConnectionId ?? originConnectionId;
    if (preferred && subscribers.some(({ id }) => id === preferred)) {
      selectedDeliveryOwnerId = preferred;
      return preferred;
    }
    if (originConnectionCanResume && originConnectionId) return null;
    const replacementId = subscribers[0]?.id ?? null;
    if (replacementId && originConnectionCanResume === false) {
      runtime.activeConnectionId = replacementId;
    }
    if (replacementId) selectedDeliveryOwnerId = replacementId;
    return replacementId;
  };
  const awaitRecoveryDeliveries = (
    deliveries: ReturnType<typeof emitToolExecutionFinishedEvents>,
  ): Promise<"sent" | "interrupted"> => {
    if (!deliveryOrigin) {
      return (async () => {
        for (const delivery of deliveries) {
          const settlements = await Promise.all(
            delivery.receipts.map((receipt) => receipt.settlement),
          );
          if (settlements.some((settlement) => settlement === "dropped")) {
            return "interrupted" as const;
          }
        }
        return "sent" as const;
      })();
    }
    runtime.pendingTerminalDeliveryCount += 1;
    return awaitOrderedOutboundDeliveries({
      deliveries,
      getOwnerId: getDeliveryOwnerId,
      shouldInterrupt: shouldInterruptDelivery,
      ...(originConnectionCanResume === false
        ? { ownerWaitTimeoutMs: OUTBOUND_QUEUE_LIMITS.MAX_BACKPRESSURE_MS }
        : {}),
    }).finally(() => {
      runtime.pendingTerminalDeliveryCount = Math.max(
        0,
        runtime.pendingTerminalDeliveryCount - 1,
      );
    });
  };
  let continuationFinalized = false;
  let sideEffectStarted = false;
  let recoveredContinuationOtid: string | null = null;
  let claimSettled = false;

  try {
    const approvedDecisions = decisions.filter(
      (decision): decision is Extract<ApprovalDecision, { type: "approve" }> =>
        decision.type === "approve",
    );
    const approvedToolCallIds = approvedDecisions.map(
      (decision) => decision.approval.toolCallId,
    );

    runtime.turnLifecycle.setExecutingToolCallIds(
      recoveryLease,
      approvedToolCallIds,
    );
    emitRuntimeStateUpdates(runtime, scope);
    const executionRunId = runtime.activeRunId ?? undefined;
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
        shouldEmit: hasRecoveryOwnership,
      },
    );
    let approvalResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
    try {
      // Hydration and tool-context preparation sit inside the try: they run
      // after the client_tool_start events above, so a throw here would
      // otherwise leave those lifecycle events orphaned.
      await ensureSecretsHydrated(runtime.listener, recovered.agentId);
      if (!hasRecoveryOwnership()) {
        return;
      }
      const modAdapters = await ensureModAdapters(
        runtime.listener,
        recovered.agentId,
      );
      if (!hasRecoveryOwnership()) {
        return;
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
        modContext: createListenerAgentModContext(recovered.agentId),
        modAdapters,
        modEvents: createListenerModEvents(modAdapters),
      });
      if (!hasRecoveryOwnership()) {
        return;
      }
      runtime.currentToolset = preparedToolContext.toolset;
      runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
      runtime.currentLoadedTools =
        preparedToolContext.preparedToolContext.loadedToolNames;
      if (!hasRecoveryOwnership()) return;
      const continuationOtid = crypto.randomUUID();
      recordWork(
        runtime,
        {
          toolCallIds: decisions.map(
            (decision) => decision.approval.toolCallId,
          ),
          results: [],
          requestOtid: continuationOtid,
        },
        "before_tool_execution",
      );
      sideEffectStarted = true;
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
        });
      } catch (error) {
        recordWork(
          runtime,
          { results: recoveredApprovalFailureResults(decisions, error) },
          "after_tool_execution",
        );
        throw error;
      }
      // Side effects have returned. Checkpoint exact outcomes before ownership
      // or transport checks; a stale process may stop delivery, not evidence.
      recordWork(runtime, { results: approvalResults }, "after_tool_execution");
      recoveredContinuationOtid = continuationOtid;
    } catch (error) {
      // Execution threw before results exist, so the finished-events
      // emission below never runs. Close the client_tool_start lifecycle
      // events explicitly or observer UIs shimmer these tool calls forever.
      // Flush buffered tool output first so no progress frame lands after
      // the terminal end events. Emit only while both local and Cloud recovery
      // ownership remain current; a fenced process retains evidence but is no
      // longer authoritative for transport events.
      emitToolExecutionOutput.flush();
      if (hasRecoveryOwnership()) {
        const abortedDeliveries = emitToolExecutionAbortedEvents(
          socket,
          runtime,
          {
            toolCallIds: approvedToolCallIds,
            runId: executionRunId,
            agentId: recovered.agentId,
            conversationId: recovered.conversationId,
          },
        );
        await awaitRecoveryDeliveries(abortedDeliveries);
      }
      throw error;
    } finally {
      emitToolExecutionOutput.flush();
    }
    if (!hasRecoveryOwnership()) {
      return;
    }

    const continuationOtid = recoveredContinuationOtid ?? crypto.randomUUID();

    const terminalDeliveries = emitToolExecutionFinishedEvents(
      socket,
      runtime,
      {
        approvals: approvalResults,
        runId: executionRunId,
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
      },
    );
    terminalDeliveries.push(
      ...emitInterruptToolReturnMessage(
        socket,
        runtime,
        approvalResults,
        executionRunId,
        "tool-return",
      ),
    );
    if ((await awaitRecoveryDeliveries(terminalDeliveries)) === "interrupted") {
      if (runtime.turnLifecycle.isCurrent(recoveryLease)) {
        runtime.turnLifecycle.markTransportInterruption(recoveryLease);
        populateInterruptQueue(runtime, {
          lastExecutionResults: approvalResults,
          lastExecutingToolCallIds: [],
          lastNeedsUserInputToolCallIds: [],
          agentId: recovered.agentId,
          conversationId: recovered.conversationId,
          requestOtid: continuationOtid,
        });
        runtime.turnLifecycle.setExecutingToolCallIds(recoveryLease, []);
        if (runtime.recoveredApprovalState === recovered) {
          clearRecoveredApprovalState(runtime);
        }
        finishRecoveredTurn({
          stopReason: recoveryLease.signal.aborted ? "cancelled" : "error",
          socket,
          agentId: recovered.agentId,
          conversationId: recovered.conversationId,
          turnId,
        });
      }
      return;
    }

    runtime.turnLifecycle.setExecutingToolCallIds(recoveryLease, []);
    setTurnLoopStatus(runtime, recoveryLease, "SENDING_API_REQUEST", scope);
    if (!hasRecoveryOwnership()) {
      return;
    }
    emitRuntimeStateUpdates(runtime, scope);

    let continuationInput = createTurnInputState([
      {
        type: "approval",
        approvals: approvalResults,
        otid: continuationOtid,
      },
    ]);
    let continuationBatchId = `batch-recovered-${crypto.randomUUID()}`;
    let continuationCorrelation: TurnCorrelation | undefined;
    const consumedQueuedTurn = consumeQueuedTurn(runtime);
    if (consumedQueuedTurn) {
      const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
      continuationBatchId = dequeuedBatch.batchId;
      continuationInput = appendQueuedTurnToInput(
        continuationInput,
        queuedTurn,
      );
      continuationCorrelation = createTurnCorrelation(
        runtime,
        {
          type: "message",
          agentId: recovered.agentId,
          conversationId: recovered.conversationId,
          messages: continuationInput.messages,
        },
        continuationBatchId,
      );
      emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
    }

    if (!hasRecoveryOwnership()) {
      runtime.dequeuedClientMessageIdsByBatchId.delete(continuationBatchId);
      return;
    }

    const continuationConnectionId =
      selectedDeliveryOwnerId ?? opts?.connectionId;
    await processTurn(
      {
        type: "message",
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
        connectionId: continuationConnectionId,
        durableInputIdentities: recovered.durableInputIdentities,
        terminalConsumerIds: recovered.terminalConsumerIds,
        messages: continuationInput.messages,
      },
      socket,
      runtime,
      opts?.onStatusChange,
      continuationConnectionId,
      continuationBatchId,
      recoveryLease,
      continuationCorrelation,
    );

    if (runtime.turnLifecycle.isCurrent(recoveryLease)) {
      throw new Error("Recovered continuation returned without finalizing");
    }
    if (runtime.turnLifecycle.kind !== "idle") {
      return;
    }
    continuationFinalized = true;
    if (recoveryClaim) {
      claimSettled = await recoveryClaim.complete();
      if (!claimSettled) return;
    } else {
      claimSettled = true;
    }

    if (runtime.recoveredApprovalState === recovered) {
      clearRecoveredApprovalState(runtime);
    }
    return;
  } catch (error) {
    if (continuationFinalized) {
      throw error;
    }
    if (!hasRecoveryOwnership()) {
      return;
    }
    const stopReason = recoveryLease.signal.aborted ? "cancelled" : "error";
    finishRecoveredTurn({
      stopReason,
      socket,
      agentId: recovered.agentId,
      conversationId: recovered.conversationId,
      turnId,
      error:
        stopReason === "error"
          ? getTranscriptLoopErrorMessage({
              error,
              message: error instanceof Error ? error.message : String(error),
            })
          : undefined,
    });
    throw error;
  } finally {
    if (recoveryClaim && !claimSettled) {
      if (sideEffectStarted) recoveryClaim.abandon();
      else await recoveryClaim.release();
    }
    if (
      recoveryClaim &&
      !recoveryClaim.owned &&
      runtime.turnLifecycle.isCurrent(recoveryLease)
    ) {
      runtime.turnLifecycle.finish(recoveryLease, "cancelled");
    }
  }
}
