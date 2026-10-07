import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ApprovalResult,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import { computeDiffPreviews } from "@/helpers/diff-preview";
import { formatPermissionDenial } from "@/permissions/format-denial";
import type { PermissionModeState } from "@/tools/permission-mode-state";
import type { ApprovalClassificationEndMessage } from "@/types/approval-classification-protocol";
import type {
  ApprovalResponseBody,
  ApprovalResponseDecision,
  ControlRequest,
} from "@/types/protocol_v2";
import { mergeImageFailureModesByMessageOtid } from "@/utils/message-image-normalization";
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
  type WaitForApprovalTransportOpen,
  waitForApprovalTransportOpen,
} from "./approval-transport-wait";
import { getSubscribedListenerConnections, TO_SUBSCRIBERS } from "./connection";
import { appendQueuedTurnToInput } from "./continuation-input";
import { readInterruptedTurn } from "./interrupted-turn-read";
import {
  type recordListenerWork,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import {
  createToolExecutionOutputEmitter,
  emitInterruptToolReturnMessage,
  emitToolExecutionAbortedEvents,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  normalizeExecutionResultsForInterruptParity,
} from "./interrupts";
import { awaitOrderedOutboundDeliveries } from "./outbound-delivery";
import { getOutboundQueueStats, OUTBOUND_QUEUE_LIMITS } from "./outbound-wire";
import {
  createLifecycleMessageBase,
  emitCanonicalMessageDelta,
  emitDequeuedUserMessage,
  emitProtocolV2Message,
  emitRuntimeStateUpdates,
  type OutboundMessageDelivery,
} from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import {
  createRecoveredApprovalEffectBoundary,
  recoveredApprovalFailureResults,
} from "./recovered-approval-checkpoint";
import { debugLogApprovalResumeState } from "./recovery";
import type {
  RecoveryAuthorityStore,
  RecoveryEvidenceWriter,
} from "./recovery-evidence";
import { ensureSecretsHydratedForAgent } from "./secrets-sync";
import {
  type ApprovalContinuationSendResult,
  markAwaitingAcceptedApprovalContinuationRunId,
  sendApprovalContinuationWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import { claimPendingTeleportAtBoundary } from "./teleport";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import {
  createTurnInputState,
  type TurnInputState,
  updateTurnInputMessagesPreservingOtids,
} from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import { setTurnLoopStatus } from "./turn-status";
import type {
  ConversationRuntime,
  IncomingMessage,
  PendingTeleport,
} from "./types";

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
type ApprovalBranchProgress = {
  turnInput: TurnInputState;
  dequeuedBatchId: string;
  pendingNormalizationInterruptedToolCallIds: string[];
  turnToolContextId: string | null;
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
  lastApprovalContinuationAccepted: boolean;
};
export type ApprovalBranchResult =
  | ({
      kind: "continue";
      stream: Stream<LettaStreamingResponse>;
    } & ApprovalBranchProgress)
  | ({ kind: "interrupted" } & ApprovalBranchProgress)
  | ({
      kind: "teleport";
      pendingTeleport: PendingTeleport;
    } & ApprovalBranchProgress)
  | ({
      kind: "terminal";
      drainResult: Extract<
        ApprovalContinuationSendResult,
        { kind: "terminal" }
      >["drainResult"];
    } & ApprovalBranchProgress)
  | { kind: "error"; message: string };
export async function handleApprovalStop(params: {
  approvals: Array<{
    toolCallId: string;
    toolName: string;
    toolArgs: string;
  }>;
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  agentId?: string | null;
  conversationId: string;
  turnWorkingDirectory: string;
  turnPermissionModeState: PermissionModeState;
  dequeuedBatchId: string;
  runId?: string;
  msgRunIds: string[];
  turnInput: TurnInputState;
  pendingNormalizationInterruptedToolCallIds: string[];
  turnToolContextId: string | null;
  turnLease: TurnLease;
  turnCorrelation?: TurnCorrelation;
  onConsumeQueuedTurn?: (queuedTurn: IncomingMessage) => void | Promise<void>;
  /** This turn's output is owned by an in-process caller, not a relay client. */
  processOwnedTurn?: boolean;
  /** Relay connection that originated this turn; replacements retain this id. */
  originConnectionId?: string;
  /** Whether the origin can return under the same logical connection id. */
  originConnectionCanResume?: boolean;
  /** Recovery authority fences transport/finalization without aborting effects. */
  authorityGuard?: () => boolean;
  /** Mutable CAS chain shared by stream and nested approval checkpoints. */
  interruptedRevisionRef?: { current: string | undefined };
  recoveryLineageId?: string;
  recoveryAuthorityStore?: RecoveryAuthorityStore;
  buildSendOptions: () => Parameters<
    typeof sendApprovalContinuationWithRetry
  >[2];
  dependencies?: {
    classifyApprovals?: typeof classifyApprovalsWithSuggestions;
    executeApprovalBatch?: typeof executeApprovalBatch;
    ensureSecretsHydrated?: typeof ensureSecretsHydratedForAgent;
    sendApprovalContinuation?: typeof sendApprovalContinuationWithRetry;
    waitForApprovalTransportOpen?: WaitForApprovalTransportOpen;
    recordListenerWork?: RecoveryEvidenceWriter;
  };
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
    turnInput,
    turnToolContextId,
    turnLease,
    turnCorrelation,
    processOwnedTurn = false,
    originConnectionId,
    originConnectionCanResume = true,
    authorityGuard = () => true,
    interruptedRevisionRef,
    recoveryLineageId,
    buildSendOptions,
    dependencies,
  } = params;
  const abortSignal = turnLease.signal;
  const classifyApprovals =
    dependencies?.classifyApprovals ?? classifyApprovalsWithSuggestions;
  const executeApprovals =
    dependencies?.executeApprovalBatch ?? executeApprovalBatch;
  const ensureSecretsHydrated =
    dependencies?.ensureSecretsHydrated ?? ensureSecretsHydratedForAgent;
  const sendApprovalContinuation =
    dependencies?.sendApprovalContinuation ?? sendApprovalContinuationWithRetry;
  const waitForTransportOpen =
    dependencies?.waitForApprovalTransportOpen ?? waitForApprovalTransportOpen;
  let checkpointChain = Promise.resolve();
  const checkpoint = (
    update: Parameters<typeof recordListenerWork>[1],
    phase: Parameters<typeof recordListenerWork>[2],
    shouldContinue?: () => boolean,
  ) => {
    const operation = checkpointChain.then(async () => {
      const revision = await (dependencies?.recordListenerWork
        ? dependencies.recordListenerWork(
            runtime,
            update,
            phase,
            interruptedRevisionRef?.current,
            recoveryLineageId,
            { shouldContinue },
          )
        : recordListenerWorkRetriably(
            runtime,
            update,
            phase,
            interruptedRevisionRef?.current,
            recoveryLineageId,
            { shouldContinue },
          ));
      if (typeof revision === "string" && interruptedRevisionRef) {
        interruptedRevisionRef.current = revision;
      }
    });
    checkpointChain = operation.catch(() => {});
    return operation;
  };
  if (approvals.length === 0) {
    return {
      kind: "error",
      message: "requires_approval stop returned no approvals",
    };
  }
  clearPendingApprovalBatchIds(runtime, approvals);
  rememberPendingApprovalBatchIds(runtime, approvals, dequeuedBatchId);
  const classificationRunId =
    runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];
  const shouldInterrupt = () =>
    abortSignal.aborted ||
    !runtime.turnLifecycle.isCurrent(turnLease) ||
    !authorityGuard();
  if (shouldInterrupt()) {
    return {
      kind: "interrupted",
      turnInput,
      dequeuedBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      lastApprovalContinuationAccepted: false,
    };
  }
  const classificationScope = {
    agent_id: agentId,
    conversation_id: conversationId,
  };
  const { autoAllowed, autoDenied, needsUserInput } = await classifyApprovals(
    approvals,
    {
      treatAskAsDeny: false,
      requireArgsForAutoApprove: true,
      missingNameReason: "Tool call incomplete - missing name",
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      agentId: agentId ?? undefined,
      toolContextId: turnToolContextId ?? undefined,
    },
  );
  if (shouldInterrupt()) {
    return {
      kind: "interrupted",
      turnInput,
      dequeuedBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults: null,
      lastExecutingToolCallIds: [],
      lastNeedsUserInputToolCallIds: [],
      lastApprovalContinuationAccepted: false,
    };
  }
  const classificationEnd: ApprovalClassificationEndMessage = {
    ...createLifecycleMessageBase(
      "approval_classification_end",
      classificationRunId,
    ),
    auto_allowed_tool_call_ids: autoAllowed.map(
      (entry) => entry.approval.toolCallId,
    ),
    auto_denied_tool_call_ids: autoDenied.map(
      (entry) => entry.approval.toolCallId,
    ),
    user_input_tool_call_ids: needsUserInput.map(
      (entry) => entry.approval.toolCallId,
    ),
  };
  emitCanonicalMessageDelta(
    socket,
    runtime,
    classificationEnd,
    classificationScope,
  );
  const continuationWasFullyAutoHandled = needsUserInput.length === 0;
  let pendingNeedsUserInput = [...needsUserInput];
  let lastNeedsUserInputToolCallIds = pendingNeedsUserInput.map(
    (ac) => ac.approval.toolCallId,
  );
  let lastExecutionResults: ApprovalResult[] | null = null;
  let lastExecutingToolCallIds: string[] = [];
  const isDeliveryReady = (): boolean => {
    const listener = runtime.listener;
    const scopedSubscribers = getSubscribedListenerConnections(listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
    const deliveryOwnerId = runtime.activeConnectionId ?? originConnectionId;
    if (deliveryOwnerId) {
      return scopedSubscribers.some(
        (connection) => connection.id === deliveryOwnerId,
      );
    }
    return scopedSubscribers.length > 0 || isListenerTransportOpen(socket);
  };
  const getDeliveryOwnerId = (): string | null => {
    const listener = runtime.listener;
    if (
      listener.connections.size === 0 &&
      isListenerTransportOpen(socket) &&
      !getOutboundQueueStats(socket).killed
    ) {
      return listener.connectionId ?? "legacy";
    }
    if (
      originConnectionId &&
      (!runtime.activeConnectionId ||
        runtime.activeConnectionId === originConnectionId)
    ) {
      const directOrigin = listener.connections.get(originConnectionId);
      const directOriginTransport =
        directOrigin?.streamWriter ?? directOrigin?.writer;
      if (
        directOrigin?.initialized &&
        directOriginTransport &&
        isListenerTransportOpen(directOriginTransport) &&
        !getOutboundQueueStats(directOriginTransport).killed
      ) {
        return originConnectionId;
      }
    }
    const scopedSubscribers = getSubscribedListenerConnections(listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    }).filter(
      (connection) =>
        !getOutboundQueueStats(connection.streamWriter ?? connection.writer)
          .killed,
    );
    const preferred = runtime.activeConnectionId ?? originConnectionId;
    if (preferred && scopedSubscribers.some(({ id }) => id === preferred)) {
      return preferred;
    }
    if (originConnectionCanResume && originConnectionId) return null;
    const replacementId = scopedSubscribers[0]?.id ?? null;
    if (replacementId && originConnectionCanResume === false) {
      runtime.activeConnectionId = replacementId;
    }
    return replacementId;
  };
  const awaitTerminalDeliveries = async (
    deliveries: OutboundMessageDelivery[],
  ): Promise<"sent" | "interrupted"> => {
    runtime.pendingTerminalDeliveryCount += 1;
    try {
      return await awaitOrderedOutboundDeliveries({
        deliveries,
        getOwnerId: getDeliveryOwnerId,
        shouldInterrupt,
        ...(originConnectionCanResume === false
          ? { ownerWaitTimeoutMs: OUTBOUND_QUEUE_LIMITS.MAX_BACKPRESSURE_MS }
          : {}),
        receiptMatchesOwner: (receipt, ownerId) =>
          receipt.connectionId === ownerId ||
          (runtime.listener.connections.size === 0 &&
            receipt.connectionId === null &&
            ownerId === (runtime.listener.connectionId ?? "legacy")),
      });
    } finally {
      runtime.pendingTerminalDeliveryCount = Math.max(
        0,
        runtime.pendingTerminalDeliveryCount - 1,
      );
    }
  };
  const interruptTermination = (
    interruptedTurnInput: TurnInputState = turnInput,
    interruptedBatchId: string = dequeuedBatchId,
  ): ApprovalBranchResult => {
    return {
      kind: "interrupted",
      turnInput: interruptedTurnInput,
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
        agent_id: agentId ?? undefined,
        conversation_id: conversationId,
      };

      let responseBody: ApprovalResponseBody;
      try {
        responseBody = await requestApprovalOverWS(
          runtime,
          socket,
          turnLease,
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
          if (shouldInterrupt()) return interruptTermination();
          const savedSuggestions = await applySuggestedPermissionsForApproval({
            decision: response,
            context: ac.context,
            workingDirectory: turnWorkingDirectory,
          });
          if (shouldInterrupt()) return interruptTermination();
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
                treatAskAsDeny: false,
                requireArgsForAutoApprove: true,
                missingNameReason: "Tool call incomplete - missing name",
                workingDirectory: turnWorkingDirectory,
                permissionModeState: turnPermissionModeState,
                agentId: agentId ?? undefined,
                toolContextId: turnToolContextId ?? undefined,
              },
            );
            if (shouldInterrupt()) return interruptTermination();

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

  const approvedDecisions = decisions.filter(
    (decision): decision is Extract<Decision, { type: "approve" }> =>
      decision.type === "approve",
  );
  const executionRunId =
    runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];

  // A process-owned turn's results are consumed in-process, so there is no
  // client whose reconnect is worth waiting for. Relay-originated turns still
  // wait through transient disconnects so their output is not lost (#3522).
  if (approvedDecisions.length > 0 && !processOwnedTurn && !isDeliveryReady()) {
    const transportOpenResult = await waitForTransportOpen(
      isDeliveryReady,
      shouldInterrupt,
    );
    if (transportOpenResult === "interrupted") {
      return interruptTermination();
    }
  }

  if (shouldInterrupt()) {
    return interruptTermination();
  }
  lastExecutingToolCallIds = approvedDecisions.map(
    (decision) => decision.approval.toolCallId,
  );
  const effectBoundary = createRecoveredApprovalEffectBoundary({
    decisions,
    ownsClaim: () => !shouldInterrupt(),
    checkpoint: (results, unstartedToolCallIds, phase) =>
      checkpoint(
        { results, unstartedToolCallIds },
        phase === "before" ? "before_tool_execution" : "after_tool_execution",
        phase === "before" ? () => !shouldInterrupt() : undefined,
      ),
    onCrossed: () => {},
  });
  await checkpoint(
    {
      toolCallIds: decisions.map((decision) => decision.approval.toolCallId),
      results: effectBoundary.initialResults,
      unstartedToolCallIds: effectBoundary.initialUnstartedToolCallIds,
      requestOtid: crypto.randomUUID(),
    },
    "before_tool_execution",
    () => !shouldInterrupt(),
  );
  if (shouldInterrupt()) return interruptTermination();
  runtime.turnLifecycle.setExecutingToolCallIds(
    turnLease,
    lastExecutingToolCallIds,
  );
  setTurnLoopStatus(runtime, turnLease, "EXECUTING_CLIENT_SIDE_TOOL", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  emitRuntimeStateUpdates(runtime, {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  emitToolExecutionStartedEvents(socket, runtime, {
    toolCalls: approvedDecisions.map((decision) => ({
      toolCallId: decision.approval.toolCallId,
      toolName: decision.approval.toolName,
      toolArgs: decision.approval.toolArgs,
    })),
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
      shouldEmit: () =>
        runtime.turnLifecycle.isCurrent(turnLease) && authorityGuard(),
    },
  );

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  // Broadcast new file content to web clients when a file-mutating tool
  // (Edit, Write) writes to disk, so all windows update immediately.
  const onFileWrite = (filePath: string, content: string) => {
    if (!runtime.turnLifecycle.isCurrent(turnLease) || !authorityGuard())
      return;
    emitProtocolV2Message(
      socket,
      runtime,
      {
        type: "file_ops",
        path: filePath,
        cg_entries: [],
        ops: [],
        source: "agent",
        document_content: content,
      } as never,
      {
        agent_id: agentId,
        conversation_id: conversationId,
      },
      TO_SUBSCRIBERS,
    );
  };

  let executionResults: Awaited<ReturnType<typeof executeApprovalBatch>>;
  try {
    if (agentId) {
      await ensureSecretsHydrated(runtime.listener, agentId);
    }
    if (shouldInterrupt()) {
      return interruptTermination();
    }
    executionResults = await executeApprovals(decisions, undefined, {
      toolContextId: turnToolContextId ?? undefined,
      abortSignal,
      onStreamingOutput: emitToolExecutionOutput,
      workingDirectory: turnWorkingDirectory,
      parentScope:
        agentId && conversationId ? { agentId, conversationId } : undefined,
      onFileWrite,
      beforeToolExecution: effectBoundary.beforeToolExecution,
      afterToolExecution: effectBoundary.afterToolExecution,
    });
  } catch (error) {
    // The batch boundary may throw after one or more tools committed side
    // effects. Persist every reported partial result and conservatively mark
    // every unknown outcome failed before transport readiness or delivery can
    // block. Recovery must never execute this batch again after a crash.
    const boundaryResults = effectBoundary.results;
    const failureResults = [
      ...boundaryResults,
      ...recoveredApprovalFailureResults(decisions, error).filter(
        (result) =>
          !boundaryResults.some(
            (saved) => saved.tool_call_id === result.tool_call_id,
          ),
      ),
    ];
    lastExecutionResults = failureResults;
    await checkpoint(
      {
        results: failureResults,
        unstartedToolCallIds: effectBoundary.unstartedToolCallIds,
      },
      "after_tool_execution",
    );

    // Execution threw before normal finished-event emission. Close the
    // client_tool_start lifecycle explicitly or observer UIs shimmer forever.
    // Abort retains precedence: its cached interrupted results own terminal
    // delivery when cancellation raced the exception.
    emitToolExecutionOutput.flush();
    if (!shouldInterrupt() && !processOwnedTurn && !isDeliveryReady()) {
      await waitForTransportOpen(isDeliveryReady, shouldInterrupt);
    }
    if (!shouldInterrupt()) {
      const abortedDeliveries = emitToolExecutionAbortedEvents(
        socket,
        runtime,
        {
          toolCallIds: lastExecutingToolCallIds,
          runId: executionRunId,
          agentId,
          conversationId,
        },
      );
      if (!processOwnedTurn) {
        await awaitTerminalDeliveries(abortedDeliveries);
      }
    }
    throw error;
  } finally {
    emitToolExecutionOutput.flush();
  }
  if (!runtime.turnLifecycle.isCurrent(turnLease)) {
    return interruptTermination();
  }
  const persistedExecutionResults = normalizeExecutionResultsForInterruptParity(
    runtime,
    turnLease,
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
  lastExecutionResults = persistedExecutionResults;
  // Tool side effects are already committed. Durably replace the pre-execution
  // empty checkpoint before any transport readiness or delivery await so a
  // crash/re-registration recovers the exact outcomes rather than stale denials.
  await checkpoint(
    { results: persistedExecutionResults, unstartedToolCallIds: [] },
    "after_tool_execution",
  );
  if (shouldInterrupt()) return interruptTermination();

  // A relay can disconnect after client-side execution begins. Do not drop the
  // terminal tool frames into the startup barrier of its replacement: wait
  // until that connection has completed state sync and becomes routable.
  if (!processOwnedTurn && !isDeliveryReady()) {
    const transportOpenResult = await waitForTransportOpen(
      isDeliveryReady,
      shouldInterrupt,
    );
    if (transportOpenResult === "interrupted") {
      return interruptTermination();
    }
  }
  const terminalDeliveries = emitToolExecutionFinishedEvents(socket, runtime, {
    approvals: persistedExecutionResults,
    runId: executionRunId,
    agentId,
    conversationId,
  });
  terminalDeliveries.push(
    ...emitInterruptToolReturnMessage(
      socket,
      runtime,
      persistedExecutionResults,
      executionRunId,
      "tool-return",
    ),
  );

  if (
    !processOwnedTurn &&
    (await awaitTerminalDeliveries(terminalDeliveries)) === "interrupted"
  ) {
    runtime.turnLifecycle.markTransportInterruption(turnLease);
    return interruptTermination();
  }

  if (shouldInterrupt()) {
    return interruptTermination();
  }

  const pendingTeleport = agentId
    ? claimPendingTeleportAtBoundary({
        listener: runtime.listener,
        agentId,
        conversationId,
        activeTurn: true,
        continuation: { approvals: persistedExecutionResults },
      })
    : null;
  if (pendingTeleport) {
    clearPendingApprovalBatchIds(
      runtime,
      decisions.map((decision) => decision.approval),
    );
    return {
      kind: "teleport",
      pendingTeleport,
      turnInput,
      dequeuedBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults,
      lastExecutingToolCallIds,
      lastNeedsUserInputToolCallIds,
      lastApprovalContinuationAccepted: false,
    };
  }

  const interruptedRecord =
    recoveryLineageId && params.recoveryAuthorityStore
      ? params.recoveryAuthorityStore.readRecoverySnapshot(
          runtime.agentId ?? "",
          runtime.conversationId,
          recoveryLineageId,
        )?.record
      : readInterruptedTurn(runtime);
  let nextTurnInput = createTurnInputState([
    {
      type: "approval",
      approvals: persistedExecutionResults,
      otid: interruptedRecord?.requestOtid ?? crypto.randomUUID(),
    },
  ]);
  let continuationBatchId = dequeuedBatchId;
  const sendOptions = buildSendOptions() ?? {};
  if (shouldInterrupt()) return interruptTermination();
  const consumedQueuedTurn = consumeQueuedTurn(runtime);
  if (consumedQueuedTurn) {
    const { dequeuedBatch, queuedTurn } = consumedQueuedTurn;
    await params.onConsumeQueuedTurn?.(queuedTurn);
    // The queued user owns this continuation request. Assignment (rather than a
    // conditional spread) also clears an actor inherited from the prior input.
    sendOptions.actingUserId = queuedTurn.actingUserId ?? null;
    turnCorrelation?.appendDequeuedBatch(dequeuedBatch.batchId);
    continuationBatchId = dequeuedBatch.batchId;
    nextTurnInput = appendQueuedTurnToInput(nextTurnInput, queuedTurn);
    emitDequeuedUserMessage(socket, runtime, queuedTurn, dequeuedBatch);
  }

  const nextInputWithSkillContent = injectQueuedSkillContent(
    nextTurnInput.messages,
    { socket, runtime, agentId, conversationId },
  );
  nextTurnInput = updateTurnInputMessagesPreservingOtids(
    nextTurnInput,
    nextInputWithSkillContent,
  );

  if (shouldInterrupt()) {
    return interruptTermination(nextTurnInput, continuationBatchId);
  }

  setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
    agent_id: agentId,
    conversation_id: conversationId,
  });
  let sendResult: ApprovalContinuationSendResult;
  try {
    const imageFailureModesByMessageOtid = mergeImageFailureModesByMessageOtid(
      sendOptions.imageFailureModesByMessageOtid,
      nextTurnInput.imageFailureModesByMessageOtid,
    );
    sendResult = await sendApprovalContinuation(
      conversationId,
      nextInputWithSkillContent,
      {
        ...sendOptions,
        ...(imageFailureModesByMessageOtid
          ? { imageFailureModesByMessageOtid }
          : {}),
        ...(continuationWasFullyAutoHandled
          ? { allowResponseStateReuse: true }
          : {}),
      },
      socket,
      runtime,
      turnLease,
      { authorityGuard },
    );
  } catch (error) {
    if (shouldInterrupt()) {
      return interruptTermination(nextTurnInput, continuationBatchId);
    }
    throw error;
  }
  if (sendResult.kind === "terminal") {
    return {
      kind: "terminal",
      drainResult: sendResult.drainResult,
      turnInput: nextTurnInput,
      dequeuedBatchId: continuationBatchId,
      pendingNormalizationInterruptedToolCallIds: [],
      turnToolContextId,
      lastExecutionResults,
      lastExecutingToolCallIds,
      lastNeedsUserInputToolCallIds,
      lastApprovalContinuationAccepted: false,
    };
  }
  const stream = sendResult.stream;

  clearPendingApprovalBatchIds(
    runtime,
    decisions.map((decision) => decision.approval),
  );
  if (agentId) {
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
  }
  markAwaitingAcceptedApprovalContinuationRunId(
    runtime,
    turnLease,
    nextTurnInput.messages,
  );
  setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  runtime.turnLifecycle.setExecutingToolCallIds(turnLease, []);
  emitRuntimeStateUpdates(runtime, {
    agent_id: agentId,
    conversation_id: conversationId,
  });

  return {
    kind: "continue",
    stream,
    turnInput: nextTurnInput,
    dequeuedBatchId: continuationBatchId,
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: null,
    lastExecutionResults,
    lastExecutingToolCallIds,
    lastNeedsUserInputToolCallIds,
    lastApprovalContinuationAccepted: true,
  };
}
