import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";
import { fetchRunErrorInfo } from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import {
  getStreamToolContextId,
  type sendMessageStream,
} from "@/agent/message";
import {
  getRetryDelayMs,
  isEmptyResponseRetryable,
  normalizeStreamErrorTypeToStopReason,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import {
  createBuffers,
  findLastAssistantText,
  toLines,
} from "@/cli/helpers/accumulator";
import { getRetryStatusMessage } from "@/cli/helpers/error-formatter";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import { telemetry } from "@/telemetry";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type { StopReasonType, StreamDelta } from "@/types/protocol_v2";
import { debugLog, isDebugEnabled } from "@/utils/debug";
import { createChannelRichDraftStreamer } from "./channel-rich-draft-streamer";
import {
  EMPTY_RESPONSE_MAX_RETRIES,
  LLM_API_ERROR_MAX_RETRIES,
  PROVIDER_FALLBACK_NOTICE,
} from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
} from "./interrupts";
import { getOrCreateConversationPermissionModeStateRef } from "./permission-mode";
import {
  emitCanonicalMessageDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitRuntimeStateUpdates,
} from "./protocol-outbound";
import {
  createProviderFallbackState,
  maybeApplyProviderFallback,
} from "./provider-fallback";
import {
  emitLoopErrorNotice,
  emitRecoverableRetryNotice,
  emitRecoverableStatusNotice,
} from "./recoverable-notices";
import {
  finalizeHandledRecoveryTurn,
  getApprovalToolCallDesyncErrorText,
  isRetriablePostStopError,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearRecoveredApprovalStateForScope,
  evictConversationRuntimeIfIdle,
} from "./runtime";
import { normalizeCwdAgentId } from "./scope";
import { markAwaitingAcceptedApprovalContinuationRunId } from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ListenerTransport } from "./transport";
import { handleApprovalStop } from "./turn-approval";
import { runListenerTurnCleanup } from "./turn-cleanup";
import { completeSuccessfulListenerTurn } from "./turn-completion";
import { releaseListenerTurnContext } from "./turn-context";
import {
  rebuildTurnInputWithFreshDenials,
  refreshTurnInputOtidsForNewRequest,
  updateTurnInputMessagesPreservingOtids,
} from "./turn-input-state";
import type { TurnLease } from "./turn-lifecycle";
import { createTurnInputSender } from "./turn-send";
import { prepareListenerTurn } from "./turn-setup";
import { setTurnLoopStatus } from "./turn-status";
import { finishListenerTurn } from "./turn-terminal";
import { seedInboundUserTranscriptLines } from "./turn-transcript";
import type { ConversationRuntime, IncomingMessage } from "./types";

export async function handleIncomingMessage(
  msg: IncomingMessage,
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void,
  connectionId?: string,
  dequeuedBatchId: string = `batch-direct-${crypto.randomUUID()}`,
  existingTurnLease?: TurnLease,
): Promise<void> {
  const agentId = msg.agentId;
  const requestedConversationId = msg.conversationId || undefined;
  const conversationId = requestedConversationId ?? "default";
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  const turnWorkingDirectory = getConversationWorkingDirectory(
    runtime.listener,
    normalizedAgentId,
    conversationId,
  );

  // Get the canonical mutable permission mode state ref for this turn.
  const turnPermissionModeState = getOrCreateConversationPermissionModeStateRef(
    runtime.listener,
    normalizedAgentId,
    conversationId,
  );

  const msgRunIds: string[] = [];
  let postStopApprovalRecoveryRetries = 0;
  let llmApiErrorRetries = 0;
  let emptyResponseRetries = 0;
  let lastApprovalContinuationAccepted = false;
  let activeDequeuedBatchId = dequeuedBatchId;

  let lastExecutionResults: ApprovalResult[] | null = null;
  let lastExecutingToolCallIds: string[] = [];
  let lastNeedsUserInputToolCallIds: string[] = [];
  const richDraftStreamer = createChannelRichDraftStreamer({
    batchId: dequeuedBatchId,
    sources: msg.channelTurnSources,
  });

  const turnLease =
    existingTurnLease ??
    runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: turnWorkingDirectory,
    });
  if (!runtime.turnLifecycle.isCurrent(turnLease)) {
    throw new Error("Cannot continue a turn with a stale lifecycle lease");
  }
  const turnAbortSignal = turnLease.signal;
  let finalizedByThisInvocation = false;
  const noteFinalization = (
    transition: ReturnType<typeof finishListenerTurn>,
  ) => {
    if (transition.finished) {
      finalizedByThisInvocation = true;
    }
    return transition;
  };
  const finishTurn = (options: Parameters<typeof finishListenerTurn>[2]) =>
    noteFinalization(finishListenerTurn(runtime, turnLease, options));
  const finishIfInterrupted = (runId?: string | null): boolean => {
    if (
      !turnAbortSignal.aborted &&
      runtime.turnLifecycle.isCurrent(turnLease)
    ) {
      return false;
    }
    finishTurn({
      stopReason: "cancelled",
      socket,
      runId,
      agentId: agentId ?? null,
      conversationId,
    });
    return true;
  };

  try {
    runtime.lastTerminalLoopErrorMessage = null;
    runtime.lastTerminalLoopErrorRunId = null;
    setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
      agent_id: agentId ?? null,
      conversation_id: conversationId,
    });
    clearRecoveredApprovalStateForScope(runtime.listener, {
      agent_id: agentId ?? null,
      conversation_id: conversationId,
    });
    emitRuntimeStateUpdates(runtime, {
      agent_id: agentId ?? null,
      conversation_id: conversationId,
    });
    telemetry.setCurrentAgentId(agentId ?? null);

    if (!agentId) {
      finishTurn({
        stopReason: "error",
        conversationId,
      });
      return;
    }

    let turnToolContextId: string | null = null;
    const setup = await prepareListenerTurn({
      msg,
      runtime,
      agentId,
      requestedConversationId,
      conversationId,
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      turnLease,
      onStatusChange,
      connectionId,
    });
    if (setup.kind === "interrupted") {
      finishTurn({
        stopReason: "cancelled",
        socket,
        agentId,
        conversationId,
      });
      return;
    }
    if (setup.kind === "cancelled") {
      const transition = finishTurn({
        stopReason: "cancelled",
        agentId: agentId || null,
        conversationId,
      });
      if (!transition.finished) {
        return;
      }
      const formattedError = emitLoopErrorNotice(socket, runtime, {
        message: setup.reason,
        stopReason: "cancelled",
        isTerminal: true,
        agentId,
        conversationId,
        cancelRequested: turnAbortSignal.aborted,
        abortSignal: turnAbortSignal,
      });
      runtime.lastTerminalLoopErrorMessage = formattedError ?? setup.reason;
      return;
    }
    let turnInput = setup.turnInput;
    const inboundUserTranscriptLines = setup.inboundUserTranscriptLines;
    const providerFallback = createProviderFallbackState(
      setup.getCachedAgent(),
    );
    let pendingNormalizationInterruptedToolCallIds =
      setup.pendingNormalizationInterruptedToolCallIds;
    const preparedToolContext = setup.preparedToolContext;
    const buildSendOptions = (): Parameters<typeof sendMessageStream>[2] => ({
      agentId,
      streamTokens: true,
      background: true,
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      preparedToolContext: preparedToolContext.preparedToolContext,
      ...(turnInput.imageFailureModesByMessageOtid
        ? {
            imageFailureModesByMessageOtid:
              turnInput.imageFailureModesByMessageOtid,
          }
        : {}),
      ...(providerFallback.overrideModel
        ? { overrideModel: providerFallback.overrideModel }
        : {}),
      ...(msg.actingUserId ? { actingUserId: msg.actingUserId } : {}),
      ...(pendingNormalizationInterruptedToolCallIds.length > 0
        ? {
            approvalNormalization: {
              interruptedToolCallIds:
                pendingNormalizationInterruptedToolCallIds,
            },
          }
        : {}),
    });

    const turnInputSender = createTurnInputSender({
      conversationId,
      agentId,
      socket,
      runtime,
      turnLease,
      providerFallback,
      buildSendOptions,
      onTerminal: noteFinalization,
    });

    const currentInputWithSkillContent = injectQueuedSkillContent(
      turnInput.messages,
    );
    const initialSendResult = await turnInputSender.send(
      currentInputWithSkillContent,
    );
    turnInput = updateTurnInputMessagesPreservingOtids(
      turnInput,
      currentInputWithSkillContent,
    );
    const initialStream = turnInputSender.accept(initialSendResult);
    if (!initialStream) {
      return;
    }
    let stream = initialStream;
    pendingNormalizationInterruptedToolCallIds = [];
    markAwaitingAcceptedApprovalContinuationRunId(
      runtime,
      turnLease,
      turnInput.messages,
    );
    setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    turnToolContextId = getStreamToolContextId(
      stream as Stream<LettaStreamingResponse>,
    );
    let runIdSent = false;
    let runId: string | undefined;
    const buffers = createBuffers(agentId);
    seedInboundUserTranscriptLines(buffers, inboundUserTranscriptLines);

    while (true) {
      runIdSent = false;
      let latestErrorText: string | null = null;
      const result = await drainStreamWithResume(
        stream as Stream<LettaStreamingResponse>,
        buffers,
        () => {},
        turnAbortSignal,
        undefined,
        ({ chunk, shouldOutput, errorInfo }) => {
          if (turnAbortSignal.aborted) {
            return undefined;
          }
          const maybeRunId = (chunk as { run_id?: unknown }).run_id;
          if (typeof maybeRunId === "string") {
            runId = maybeRunId;
            runtime.turnLifecycle.setRunId(turnLease, maybeRunId);
            if (!runIdSent) {
              runIdSent = true;
              msgRunIds.push(maybeRunId);
              emitLoopStatusUpdate(socket, runtime, {
                agent_id: agentId,
                conversation_id: conversationId,
              });
            }
          }

          if (errorInfo) {
            const recoverableApprovalErrorText =
              getApprovalToolCallDesyncErrorText(errorInfo);
            latestErrorText =
              recoverableApprovalErrorText ||
              errorInfo.detail ||
              errorInfo.message ||
              latestErrorText;
            if (!recoverableApprovalErrorText) {
              emitLoopErrorNotice(socket, runtime, {
                message: errorInfo.message || "Stream error",
                stopReason: normalizeStreamErrorTypeToStopReason(
                  errorInfo.error_type,
                ),
                isTerminal: false,
                runId: runId || errorInfo.run_id,
                agentId,
                conversationId,
                errorInfo,
                cancelRequested: turnAbortSignal.aborted,
                abortSignal: turnAbortSignal,
              });
            } else {
              debugLog(
                "recovery",
                "Suppressing streamed approval conflict while post-stop recovery runs: %s",
                recoverableApprovalErrorText,
              );
            }
          }

          richDraftStreamer?.handleChunk(
            chunk as unknown as LettaStreamingResponse,
          );

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
                  agent_id: agentId,
                  conversation_id: conversationId,
                },
              );
            }
          }

          return undefined;
        },
        runtime.contextTracker,
      );

      const stopReason = result.stopReason;
      const approvals = result.approvals || [];
      const fallbackError = result.fallbackError ?? null;
      if (finishIfInterrupted(runId || runtime.activeRunId)) {
        break;
      }
      if (stopReason === "requires_approval" || stopReason === "end_turn") {
        await richDraftStreamer?.flushPending();
      }
      if (finishIfInterrupted(runId || runtime.activeRunId)) {
        break;
      }
      lastApprovalContinuationAccepted = false;

      if (stopReason === "end_turn") {
        const transcriptLines = toLines(buffers);
        const completion = await completeSuccessfulListenerTurn({
          runtime,
          socket,
          agentId,
          conversationId,
          workingDirectory: turnWorkingDirectory,
          permissionMode: turnPermissionModeState.mode,
          actingUserId: msg.actingUserId,
          assistantMessage: findLastAssistantText(transcriptLines),
          transcriptLines,
          getCachedAgent: setup.getCachedAgent,
          isInterrupted: () =>
            turnAbortSignal.aborted ||
            !runtime.turnLifecycle.isCurrent(turnLease),
        });
        if (
          completion === "interrupted" ||
          finishIfInterrupted(runId || runtime.activeRunId)
        ) {
          break;
        }
        finishTurn({
          stopReason: "end_turn",
          agentId,
          conversationId,
        });

        break;
      }

      if (stopReason === "cancelled") {
        finishTurn({
          stopReason: "cancelled",
          socket,
          runId: runId || runtime.activeRunId,
          agentId: agentId ?? null,
          conversationId,
        });
        break;
      }

      if (stopReason !== "requires_approval") {
        const lastRunId = runId || msgRunIds[msgRunIds.length - 1] || null;
        const runErrorInfo = lastRunId
          ? await fetchRunErrorInfo(lastRunId)
          : null;
        if (finishIfInterrupted(lastRunId || runtime.activeRunId)) {
          break;
        }
        const errorDetail =
          latestErrorText ||
          runErrorInfo?.detail ||
          runErrorInfo?.message ||
          fallbackError ||
          null;

        if (
          shouldAttemptPostStopApprovalRecovery({
            stopReason,
            runIdsSeen: msgRunIds.length,
            retries: postStopApprovalRecoveryRetries,
            runErrorDetail: errorDetail,
            latestErrorText,
            fallbackError,
          })
        ) {
          postStopApprovalRecoveryRetries += 1;
          emitRecoverableStatusNotice(socket, runtime, {
            kind: "stale_approval_conflict_recovery",
            message:
              "Recovering from stale approval conflict after interrupted/reconnected turn",
            level: "warning",
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          try {
            const agent = await getBackend().retrieveAgent(agentId || "");
            const { pendingApprovals: existingApprovals } =
              await getResumeDataFromBackend(agent, requestedConversationId);
            turnInput = rebuildTurnInputWithFreshDenials(
              turnInput,
              existingApprovals ?? [],
              "Auto-denied: stale approval from interrupted session",
            );
          } catch {
            turnInput = rebuildTurnInputWithFreshDenials(turnInput, [], "");
          }
          if (finishIfInterrupted(lastRunId || runtime.activeRunId)) {
            break;
          }

          setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const retryInputWithSkillContent = injectQueuedSkillContent(
            turnInput.messages,
          );
          const retrySendResult = await turnInputSender.send(
            retryInputWithSkillContent,
          );
          turnInput = updateTurnInputMessagesPreservingOtids(
            turnInput,
            retryInputWithSkillContent,
          );
          const retryStream = turnInputSender.accept(retrySendResult);
          if (!retryStream) {
            return;
          }
          stream = retryStream;
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(
            runtime,
            turnLease,
            turnInput.messages,
          );
          setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        if (
          isEmptyResponseRetryable(
            stopReason === "llm_api_error" ? "llm_error" : undefined,
            errorDetail,
            emptyResponseRetries,
            EMPTY_RESPONSE_MAX_RETRIES,
          )
        ) {
          emptyResponseRetries += 1;
          const attempt = emptyResponseRetries;
          const delayMs = getRetryDelayMs({
            category: "empty_response",
            attempt,
          });

          if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
            turnInput = updateTurnInputMessagesPreservingOtids(turnInput, [
              ...turnInput.messages,
              {
                type: "message" as const,
                role: "system" as const,
                content:
                  "<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>",
              },
            ]);
          }

          emitRetryDelta(socket, runtime, {
            message: `Empty LLM response, retrying (attempt ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES})...`,
            reason: "llm_api_error",
            attempt,
            maxAttempts: EMPTY_RESPONSE_MAX_RETRIES,
            delayMs,
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (turnAbortSignal.aborted) {
            throw new Error("Cancelled by user");
          }
          turnInput = refreshTurnInputOtidsForNewRequest(turnInput);

          setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const retryInputWithSkillContent = injectQueuedSkillContent(
            turnInput.messages,
          );
          const retrySendResult = await turnInputSender.send(
            retryInputWithSkillContent,
          );
          turnInput = updateTurnInputMessagesPreservingOtids(
            turnInput,
            retryInputWithSkillContent,
          );
          const retryStream = turnInputSender.accept(retrySendResult);
          if (!retryStream) {
            return;
          }
          stream = retryStream;
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(
            runtime,
            turnLease,
            turnInput.messages,
          );
          setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        const retriable = await isRetriablePostStopError(
          (stopReason as StopReasonType) || "error",
          lastRunId,
          errorDetail,
        );
        if (finishIfInterrupted(lastRunId || runtime.activeRunId)) {
          break;
        }
        if (retriable && llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          llmApiErrorRetries += 1;
          const attempt = llmApiErrorRetries;
          const fallbackHandle = maybeApplyProviderFallback(
            providerFallback,
            attempt,
          );
          const delayMs = fallbackHandle
            ? 0
            : getRetryDelayMs({
                category: "transient_provider",
                attempt,
                detail: errorDetail,
              });
          const retryMessage = fallbackHandle
            ? PROVIDER_FALLBACK_NOTICE
            : getRetryStatusMessage(errorDetail) ||
              `LLM API error encountered, retrying (attempt ${attempt}/${LLM_API_ERROR_MAX_RETRIES})...`;
          emitRecoverableRetryNotice(socket, runtime, {
            kind: "transient_provider_retry",
            message: retryMessage,
            reason: "llm_api_error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          if (!fallbackHandle) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          if (turnAbortSignal.aborted) {
            throw new Error("Cancelled by user");
          }
          turnInput = refreshTurnInputOtidsForNewRequest(turnInput);

          setTurnLoopStatus(runtime, turnLease, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const retryInputWithSkillContent = injectQueuedSkillContent(
            turnInput.messages,
          );
          const retrySendResult = await turnInputSender.send(
            retryInputWithSkillContent,
          );
          turnInput = updateTurnInputMessagesPreservingOtids(
            turnInput,
            retryInputWithSkillContent,
          );
          const retryStream = turnInputSender.accept(retrySendResult);
          if (!retryStream) {
            return;
          }
          stream = retryStream;
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(
            runtime,
            turnLease,
            turnInput.messages,
          );
          setTurnLoopStatus(runtime, turnLease, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        const effectiveStopReason: StopReasonType = turnAbortSignal.aborted
          ? "cancelled"
          : (stopReason as StopReasonType) || "error";

        if (effectiveStopReason === "cancelled") {
          finishTurn({
            stopReason: "cancelled",
            socket,
            runId: runId || runtime.activeRunId,
            agentId: agentId ?? null,
            conversationId,
          });
          break;
        }

        const errorMessage =
          errorDetail || `Unexpected stop reason: ${stopReason}`;

        const terminalRunId =
          runId || runtime.activeRunId || runErrorInfo?.run_id;
        const transition = finishTurn({
          stopReason: effectiveStopReason,
          agentId,
          conversationId,
        });
        if (!transition.finished) {
          break;
        }
        const formattedError = emitLoopErrorNotice(socket, runtime, {
          message: errorMessage,
          stopReason: effectiveStopReason,
          isTerminal: true,
          runId: terminalRunId,
          agentId,
          conversationId,
          runErrorInfo: runErrorInfo ?? undefined,
          cancelRequested: turnAbortSignal.aborted,
          abortSignal: turnAbortSignal,
        });
        runtime.lastTerminalLoopErrorMessage = formattedError ?? errorMessage;
        runtime.lastTerminalLoopErrorRunId = terminalRunId ?? null;
        break;
      }

      const approvalResult = await handleApprovalStop({
        approvals,
        runtime,
        socket,
        agentId,
        conversationId,
        turnWorkingDirectory,
        turnPermissionModeState,
        dequeuedBatchId: activeDequeuedBatchId,
        runId,
        msgRunIds,
        turnInput,
        pendingNormalizationInterruptedToolCallIds,
        turnToolContextId,
        turnLease,
        buildSendOptions,
        providerFallback,
      });

      if (approvalResult.kind === "error") {
        const terminalRunId = runId || runtime.activeRunId;
        const transition = finishTurn({
          stopReason: "error",
          agentId,
          conversationId,
        });
        if (!transition.finished) {
          return;
        }
        const formattedError = emitLoopErrorNotice(socket, runtime, {
          message: approvalResult.message,
          stopReason: "error",
          isTerminal: true,
          runId: terminalRunId,
          agentId,
          conversationId,
        });
        runtime.lastTerminalLoopErrorMessage =
          formattedError ?? approvalResult.message;
        runtime.lastTerminalLoopErrorRunId = terminalRunId ?? null;
        return;
      }

      turnInput = approvalResult.turnInput;
      activeDequeuedBatchId = approvalResult.dequeuedBatchId;
      pendingNormalizationInterruptedToolCallIds =
        approvalResult.pendingNormalizationInterruptedToolCallIds;
      turnToolContextId = approvalResult.turnToolContextId;
      lastExecutionResults = approvalResult.lastExecutionResults;
      lastExecutingToolCallIds = approvalResult.lastExecutingToolCallIds;
      lastNeedsUserInputToolCallIds =
        approvalResult.lastNeedsUserInputToolCallIds;
      lastApprovalContinuationAccepted =
        approvalResult.lastApprovalContinuationAccepted;

      if (approvalResult.kind === "interrupted") {
        if (runtime.turnLifecycle.isCurrent(turnLease)) {
          populateInterruptQueue(runtime, {
            lastExecutionResults,
            lastExecutingToolCallIds,
            lastNeedsUserInputToolCallIds,
            agentId: agentId || "",
            conversationId,
          });
        }
        finishTurn({
          stopReason: "cancelled",
          socket,
          runId: runId || runtime.activeRunId,
          agentId,
          conversationId,
        });
        return;
      }

      if (approvalResult.kind === "terminal") {
        noteFinalization(
          finalizeHandledRecoveryTurn(runtime, socket, turnLease, {
            drainResult: approvalResult.drainResult,
            agentId,
            conversationId,
          }),
        );
        return;
      }

      stream = approvalResult.stream;
      turnToolContextId = getStreamToolContextId(
        stream as Stream<LettaStreamingResponse>,
      );
    }
  } catch (error) {
    trackBoundaryError({
      errorType: "listener_turn_processing_failed",
      error,
      context: "listener_turn_processing",
      runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
    });
    if (turnAbortSignal.aborted) {
      if (
        runtime.turnLifecycle.isCurrent(turnLease) &&
        !lastApprovalContinuationAccepted
      ) {
        populateInterruptQueue(runtime, {
          lastExecutionResults,
          lastExecutingToolCallIds,
          lastNeedsUserInputToolCallIds,
          agentId: agentId || "",
          conversationId,
        });
        const approvalsForEmission = getInterruptApprovalsForEmission(runtime, {
          lastExecutionResults,
          agentId: agentId || "",
          conversationId,
        });
        if (approvalsForEmission) {
          emitToolExecutionFinishedEvents(socket, runtime, {
            approvals: approvalsForEmission,
            runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
            agentId: agentId || "",
            conversationId,
          });
          emitInterruptToolReturnMessage(
            socket,
            runtime,
            approvalsForEmission,
            runtime.activeRunId || msgRunIds[msgRunIds.length - 1] || undefined,
          );
        }
      }

      finishTurn({
        stopReason: "cancelled",
        socket,
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        agentId: agentId || null,
        conversationId,
      });

      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    const terminalRunId = runtime.activeRunId;
    const transition = finishTurn({
      stopReason: "error",
      agentId: agentId || null,
      conversationId,
    });
    if (!transition.finished) {
      return;
    }
    const formattedError = emitLoopErrorNotice(socket, runtime, {
      message: errorMessage,
      stopReason: "error",
      isTerminal: true,
      runId: terminalRunId,
      agentId: agentId || undefined,
      conversationId,
      error,
      cancelRequested: turnAbortSignal.aborted,
      abortSignal: turnAbortSignal,
    });
    runtime.lastTerminalLoopErrorMessage = formattedError ?? errorMessage;
    runtime.lastTerminalLoopErrorRunId = terminalRunId ?? null;
    if (isDebugEnabled()) {
      console.error("[Listen] Error handling message:", error);
    }
  } finally {
    if (runtime.turnLifecycle.isCurrent(turnLease)) {
      trackBoundaryError({
        errorType: "listener_turn_unfinalized_exit",
        error: new Error("Turn owner exited without a terminal transition"),
        context: "listener_turn_finalization",
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
      });
      finishTurn({
        stopReason: turnAbortSignal.aborted ? "cancelled" : "error",
        socket,
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        agentId: agentId || null,
        conversationId,
      });
    }

    richDraftStreamer?.dispose();

    try {
      if (finalizedByThisInvocation) {
        await runListenerTurnCleanup({
          runtime,
          agentId,
          normalizedAgentId,
          conversationId,
        });
      }
    } finally {
      releaseListenerTurnContext({ runtime, agentId, conversationId });
    }

    evictConversationRuntimeIfIdle(runtime);
  }
}
