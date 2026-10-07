import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import { normalizeStreamErrorTypeToStopReason } from "@/agent/turn-recovery-policy";
import { createBuffers } from "@/cli/helpers/accumulator";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import type { StreamDelta } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { normalizeCloudRetryWireMessage } from "./cloud-retry-message";
import {
  findListenerConnectionByTransport,
  getSubscribedListenerConnections,
} from "./connection";
import { LISTENER_STREAM_RESUME_POLICY } from "./constants";
import { appendQueuedTurnToInput } from "./continuation-input";
import { promotePreparedInputTerminals } from "./conversation-runtime";
import { getConversationWorkingDirectory } from "./cwd";
import { readInterruptedTurn } from "./interrupted-turn-read";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
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
import {
  createRecoveredApprovalEffectBoundary,
  recoveredApprovalFailureResults,
} from "./recovered-approval-checkpoint";

export {
  getApprovalToolCallDesyncErrorText,
  isApprovalToolCallDesyncError,
  isRetriablePostStopError,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery-error-policy";

import {
  fenceLostRecoveryClaim,
  scheduleRecoveredApprovalRetry,
} from "./recovered-approval-retry";
import { rehydrateClaimLostQueuedTurn } from "./recovered-queue-rehydration";
import {
  createRecoveredTurnFinalizer,
  finalizeHandledRecoveryTurn,
} from "./recovered-turn-finalizer";
import {
  markRecoveryClaimCompletionPending,
  retireAcknowledgedRecoveryClaim,
} from "./recovery-claim-completion";
import {
  createRecoveryEvidenceCheckpoint,
  type RecoveredContinuationProcessTurn,
  type RecoveryEvidenceWriter,
  type SettledRecoveryResultWriter,
} from "./recovery-evidence";
import {
  acquireRecoveryClaim,
  type canRecoverConversation,
  type RecoveryClaim,
  resolveRecoveryEligibility,
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
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { replayPendingTurnFinishedToConnection } from "./turn-finished-replay";
import { createTurnInputState } from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";

export { debugLogApprovalResumeState } from "./recovery-debug";
export { finalizeHandledRecoveryTurn };

import type { ConversationRuntime } from "./types";
export async function drainRecoveryStreamWithEmission(
  recoveryStream: Stream<LettaStreamingResponse>,
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  params: {
    agentId?: string | null;
    conversationId: string;
    turnLease: TurnLease;
    turnCorrelation?: TurnCorrelation;
    authorityGuard?: () => boolean;
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
      if (
        !runtime.turnLifecycle.isCurrent(params.turnLease) ||
        params.authorityGuard?.() === false
      ) {
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

export type RecoveredContinuationDependencies = {
  ensureSecretsHydrated?: typeof ensureSecretsHydratedForAgent;
  ensureModAdapters?: typeof ensureListenerModAdaptersForAgent;
  prepareToolExecutionContext?: typeof prepareToolExecutionContextForScope;
  executeApprovalBatch?: typeof executeApprovalBatch;
  executeTool?: NonNullable<
    Parameters<typeof executeApprovalBatch>[2]
  >["executeTool"];
  recordListenerWork?: RecoveryEvidenceWriter;
  mergeSettledRecoveryResult?: SettledRecoveryResultWriter;
  acquireRecoveryClaim?: typeof acquireRecoveryClaim;
  canRecover?: typeof canRecoverConversation;
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
  onLeaseAcquired?: () => Promise<void>;
};
/** Resume recovered approvals immediately instead of parking them for input. */
export async function startRecoveredApprovalContinuation(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  processTurn: RecoveredContinuationProcessTurn,
  opts?: RecoveredContinuationOptions,
): Promise<boolean> {
  const recovered = runtime.recoveredApprovalState;
  if (!recovered?.autoDecisions || recovered.autoDecisions.length === 0) {
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
  const canRecover = opts?.dependencies?.canRecover;
  const eligibility = await resolveRecoveryEligibility(runtime, canRecover);
  if (eligibility !== "owned") {
    if (eligibility === "unavailable") return false;
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
  let retryAfterClaimLoss = false;
  let sideEffectMayHaveRun = false;
  const acquireClaim =
    opts?.dependencies?.acquireRecoveryClaim ?? acquireRecoveryClaim;
  const recoveryClaim = await acquireClaim(runtime, () => {
    retryAfterClaimLoss = true;
    fenceLostRecoveryClaim(runtime, recoveryLease, sideEffectMayHaveRun);
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
  await opts?.onLeaseAcquired?.();
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
    onSideEffectStarted: () => {
      sideEffectMayHaveRun = true;
    },
  });
  if (retryAfterClaimLoss && !runtime.listener.intentionallyClosed) {
    if (sideEffectMayHaveRun) {
      try {
        promotePreparedInputTerminals(runtime.listener);
        const connectionId = runtime.activeConnectionId ?? opts?.connectionId;
        if (connectionId) {
          replayPendingTurnFinishedToConnection(socket, runtime, connectionId);
        }
      } catch (error) {
        debugWarn("recovery", "Failed to replay claim-loss terminal", error);
      }
      if (runtime.recoveredApprovalState === recovered) {
        clearRecoveredApprovalState(runtime);
      }
    }
    if (runtime.listener.scheduleRecordedRecovery) {
      runtime.listener.scheduleRecordedRecovery();
    } else {
      scheduleRecoveredApprovalRetry(runtime, () =>
        startRecoveredApprovalContinuation(runtime, socket, processTurn, opts),
      );
    }
  }
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
  onSideEffectStarted: () => void;
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
    onSideEffectStarted,
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
  const recordWork = dependencies?.recordListenerWork;
  if (
    recordWork &&
    !dependencies?.mergeSettledRecoveryResult &&
    !dependencies?.executeApprovalBatch &&
    decisions.some(
      (decision) => decision.type === "approve" && !decision.precomputedResult,
    )
  ) {
    throw new Error(
      "Custom recovery evidence writer requires exact-result merge capability",
    );
  }
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
  const recoveryLineageId = recovered.recoveryLineageId ?? crypto.randomUUID();
  const evidence = createRecoveryEvidenceCheckpoint(
    runtime,
    recordWork,
    recovered.recoveryRevisionToken ?? recovered.interruptedRevision,
    recoveryLineageId,
    dependencies?.mergeSettledRecoveryResult,
  );
  const interruptedTerminalRevision = () =>
    recovered.recoveryUsesIndependentSuccessor
      ? recovered.interruptedRevision
      : evidence.revision;
  const finishRecoveredTurn = createRecoveredTurnFinalizer({
    runtime,
    recoveryLease,
    recovered,
    getInterruptedRevision: interruptedTerminalRevision,
    getAuthorityRevision: () => evidence.revision,
    canCommit: hasRecoveryOwnership,
  });
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
    // Claim authority can disappear at this async extension boundary.
    if (!hasRecoveryOwnership()) return;
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
        actingUserId: recovered.actingUserId,
        suppressActingUserFallback: recovered.actingUserId === undefined,
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
      const effectBoundary = createRecoveredApprovalEffectBoundary({
        decisions,
        ownsClaim: hasRecoveryOwnership,
        checkpoint: (results, unstartedToolCallIds, phase) =>
          evidence.write(
            { results, unstartedToolCallIds },
            phase === "before"
              ? "before_tool_execution"
              : "after_tool_execution",
            phase === "before"
              ? { shouldContinue: hasRecoveryOwnership }
              : undefined,
          ),
        onCrossed: () => {
          sideEffectStarted = true;
          onSideEffectStarted();
        },
        checkpointExactResult: (result) =>
          evidence.checkpointSettledResult(result),
      });
      await evidence.write(
        {
          toolCallIds: decisions.map(({ approval }) => approval.toolCallId),
          results: effectBoundary.initialResults,
          unstartedToolCallIds: effectBoundary.initialUnstartedToolCallIds,
          requestOtid: continuationOtid,
          recoveryClaimCompletion: {
            lineageId: recoveryLineageId,
            state: "running",
            effectToolCallIds: decisions.map(
              ({ approval }) => approval.toolCallId,
            ),
            effectRunId: runtime.activeRunId,
            effectRequestOtid: continuationOtid,
            effectWorkingDirectory: workingDirectory,
            effectActingUserId: recovered.actingUserId ?? null,
            effectResults: effectBoundary.initialResults,
            effectUnstartedToolCallIds:
              effectBoundary.initialUnstartedToolCallIds,
            effectInputIdentities: [
              ...(recovered.durableInputIdentities ?? []),
            ],
            effectTerminalConsumerIds: [
              ...(recovered.terminalConsumerIds ?? []),
            ],
            effectTeleport: undefined,
          },
        },
        "before_tool_execution",
        { shouldContinue: hasRecoveryOwnership },
      );
      if (!hasRecoveryOwnership()) return;
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
          beforeToolExecution: effectBoundary.beforeToolExecution,
          afterToolExecution: effectBoundary.afterToolExecution,
          executeTool: dependencies?.executeTool,
        });
      } catch (error) {
        if (effectBoundary.claimLost) return;
        await evidence.write(
          {
            unstartedToolCallIds: effectBoundary.unstartedToolCallIds,
            results: [
              ...effectBoundary.results,
              ...recoveredApprovalFailureResults(decisions, error).filter(
                (result) =>
                  !effectBoundary.results.some(
                    (saved) => saved.tool_call_id === result.tool_call_id,
                  ),
              ),
            ],
          },
          "after_tool_execution",
        );
        throw error;
      }
      await evidence.write(
        {
          results: effectBoundary.results,
          unstartedToolCallIds: effectBoundary.unstartedToolCallIds,
        },
        "after_tool_execution",
      );
      recoveredContinuationOtid = continuationOtid;
    } catch (error) {
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
        // Delivery interruption is not a process restart. Retained evidence needs
        // an explicit same-daemon wake once a replacement transport can consume it.
        runtime.listener.scheduleRecordedRecovery?.();
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
    const continuationOwnership = createTurnDurabilityOwnership();
    continuationOwnership.recordInput(recovered);
    const consumedQueuedTurn = consumeQueuedTurn(runtime);
    if (consumedQueuedTurn) {
      const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
      continuationOwnership.recordInput(queuedTurn);
      try {
        await evidence.checkpointOwnership(
          continuationOwnership,
          queuedTurn.actingUserId,
        );
      } catch (error) {
        runtime.dequeuedClientMessageIdsByBatchId.delete(dequeuedBatch.batchId);
        runtime.dequeuedInputIdentitiesByBatchId.delete(dequeuedBatch.batchId);
        rehydrateClaimLostQueuedTurn(
          runtime,
          socket,
          queuedTurn,
          opts,
          processTurn,
        );
        throw error;
      }
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
          durableInputIdentities: continuationOwnership.durableInputIdentities,
          terminalConsumerIds: continuationOwnership.terminalConsumerIds,
          messages: continuationInput.messages,
        },
        continuationBatchId,
      );
      emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
    }

    if (!hasRecoveryOwnership()) {
      runtime.dequeuedClientMessageIdsByBatchId.delete(continuationBatchId);
      runtime.dequeuedInputIdentitiesByBatchId.delete(continuationBatchId);
      if (consumedQueuedTurn) {
        const { queuedTurn } = consumedQueuedTurn;
        rehydrateClaimLostQueuedTurn(
          runtime,
          socket,
          queuedTurn,
          opts,
          processTurn,
        );
      }
      return;
    }

    const continuationConnectionId =
      selectedDeliveryOwnerId ?? opts?.connectionId;
    const continuationActingUserId = consumedQueuedTurn
      ? consumedQueuedTurn.queuedTurn.actingUserId
      : recovered.actingUserId;
    await processTurn(
      {
        type: "message",
        agentId: recovered.agentId,
        conversationId: recovered.conversationId,
        actingUserId: continuationActingUserId,
        suppressActingUserFallback: continuationActingUserId === undefined,
        connectionId: continuationConnectionId,
        durableInputIdentities: continuationOwnership.durableInputIdentities,
        terminalConsumerIds: continuationOwnership.terminalConsumerIds,
        messages: continuationInput.messages,
      },
      socket,
      runtime,
      opts?.onStatusChange,
      continuationConnectionId,
      continuationBatchId,
      recoveryLease,
      continuationCorrelation,
      hasRecoveryOwnership,
      true,
      interruptedTerminalRevision(),
      recoveryClaim !== null,
      recoveryLineageId,
    );

    if (runtime.turnLifecycle.isCurrent(recoveryLease)) {
      throw new Error("Recovered continuation returned without finalizing");
    }
    if (runtime.turnLifecycle.kind !== "idle") {
      return;
    }
    continuationFinalized = true;
    if (recoveryClaim) {
      const completed = readInterruptedTurn(runtime);
      if (!completed) {
        // Observer-only recovery has no local execution evidence to retire.
        claimSettled = await recoveryClaim.complete();
        if (!claimSettled) return;
      } else {
        if (
          !completed.revision ||
          completed.recoveryClaimCompletion?.lineageId !== recoveryLineageId
        ) {
          await recoveryClaim.release();
          claimSettled = true;
          runtime.listener.scheduleRecordedRecovery?.();
          return;
        }
        const pendingCompletionRevision = markRecoveryClaimCompletionPending(
          createInterruptedTurnStore(),
          completed,
        )?.revision;
        if (!pendingCompletionRevision) {
          await recoveryClaim.release();
          claimSettled = true;
          runtime.listener.scheduleRecordedRecovery?.();
          return;
        }
        claimSettled = await recoveryClaim.complete();
        if (!claimSettled) return;
        // Completion is the remote exactly-once boundary. An independent writer
        // may have advanced the record while complete() was awaiting its ACK; in
        // that case clear only this lineage's marker and preserve successor work.
        const retirement = pendingCompletionRevision
          ? retireAcknowledgedRecoveryClaim(createInterruptedTurnStore(), {
              agentId: completed.agentId,
              conversationId: completed.conversationId,
              lineageId: recoveryLineageId,
              pendingRevision: pendingCompletionRevision,
            })
          : "failed";
        if (retirement === "failed" || retirement === "preserved") {
          runtime.listener.scheduleRecordedRecovery?.();
        }
      }
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
