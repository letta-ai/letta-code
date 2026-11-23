import { randomUUID } from "node:crypto";
import { APIError } from "@letta-ai/letta-client/core/error";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
} from "react";
import {
  type ApprovalResult,
  appendAbortPartials,
  buildDeniedResults,
  executeAutoAllowedTools,
  isUserAbortError,
  overlayPartialResults,
} from "@/agent/approval-execution";
import {
  CONVERSATION_BUSY_WAIT_TIMEOUT_MS,
  extractConflictDetail,
  extractConversationBusyRunId,
  fetchRunErrorInfo,
  getPreStreamErrorAction,
  getRetryDelayMs,
  isApprovalPendingError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  isQuotaLimitErrorDetail,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  refreshInputOtidsForNewRequest,
  reportBusyRetryExhausted,
  resumeConversationBusyRequest,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
  waitForConversationBusyRunOrThrow,
} from "@/agent/approval-recovery";
import { getAvailableModelHandles } from "@/agent/available-models";
import {
  CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN,
  formatPlanRotationNotice,
  rotateChatGPTPlanOnQuotaLimit,
} from "@/agent/chatgpt-plan-rotation";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getStreamToolContextId, sendMessageStream } from "@/agent/message";
import { getModelInfoForLlmConfig } from "@/agent/model";
import { INTERRUPT_RECOVERY_ALERT } from "@/agent/prompt-assets";
import type { SessionStats } from "@/agent/stats";
import {
  clearCompletedSubagents,
  hasActiveSubagents,
} from "@/agent/subagent-state";
import { getBackend } from "@/backend";
import {
  type Buffers,
  type Line,
  markIncompleteToolsAsCancelled,
  onChunk,
  setToolCallsRunning,
  toLines,
} from "@/cli/helpers/accumulator";
import { classifyApprovals } from "@/cli/helpers/approval-classification";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import {
  type AdvancedDiffSuccess,
  computeAdvancedDiff,
  parsePatchToAdvancedDiff,
} from "@/cli/helpers/diff";
import {
  formatErrorDetails,
  formatTelemetryErrorMessage,
  getRetryStatusMessage,
  isEncryptedContentError,
  isProviderStreamDisconnectErrorText,
  KEY_OR_CREDITS_REQUIRED_MESSAGE,
} from "@/cli/helpers/error-formatter";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import {
  buildLocalNoModelResponse,
  splitSyntheticAssistantResponse,
} from "@/cli/helpers/local-no-model-response";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import { getQueuedNotificationSummaries } from "@/cli/helpers/queued-message-parts";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import {
  type ApprovalRequest,
  advanceStreamSequenceCursor,
  drainStreamWithResume,
  recordEmptyApprovalTelemetry,
  type StreamSequenceCursor,
} from "@/cli/helpers/stream";
import { shouldClearCompletedSubagentsOnTurnStart } from "@/cli/helpers/subagent-turn-start";
import {
  getRandomPastTenseVerb,
  getRandomThinkingVerb,
} from "@/cli/helpers/thinking-messages";
import {
  isFileEditTool,
  isFileWriteTool,
  isPatchTool,
} from "@/cli/helpers/tool-name-mapping";
import { finishTuiTurn } from "@/cli/helpers/tui-turn-lifecycle";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { runStopHooks } from "@/hooks";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";
import type { ApprovalContext } from "@/permissions/analyzer";
import { formatPermissionDenial } from "@/permissions/format-denial";
import type { PermissionMode } from "@/permissions/mode";
import { permissionMode } from "@/permissions/mode";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { replaceClientPreferences } from "@/tools/client-preferences";
import { analyzeToolApproval, type ToolExecutionResult } from "@/tools/manager";
import type { PreparedScopeToolContext } from "@/tools/toolset";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

import {
  CONVERSATION_BUSY_MAX_RETRIES,
  EAGER_CANCEL,
  EMPTY_RESPONSE_MAX_RETRIES,
  ERROR_FEEDBACK_HINT,
  INTERRUPT_MESSAGE,
  LLM_API_ERROR_MAX_RETRIES,
} from "./constants";
import { extractErrorMeta } from "./errors";
import { uid } from "./ids";
import {
  getErrorHintForStopReason,
  getPreferredAgentModelHandle,
} from "./model-config";
import { sendDesktopNotification } from "./notifications";
import { isRetriableError } from "./retry";
import { getRestorableUserText } from "./system-reminders";
import { prepareTuiQueuedTurn } from "./turn-input";
import type {
  AppendError,
  ApprovalDecision,
  AutoAllowedExecution,
  AutoDeniedApproval,
  AutoHandledToolResult,
  QueueApprovalResults,
} from "./types";

type NetworkPhase = "error" | "upload" | "download" | null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeExecutionPhaseHook(
  setExecutionPhase: Dispatch<SetStateAction<ExecutionPhase>>,
) {
  return ({ chunk }: { chunk: { message_type?: string } }) => {
    const t = chunk?.message_type;
    if (t === "reasoning_message") setExecutionPhase("thinking");
    else if (t === "tool_call_message" || t === "approval_request_message")
      setExecutionPhase("toolUse");
    else if (t === "assistant_message") setExecutionPhase("responding");
    return undefined;
  };
}

function hasUserMessageInput(
  input: Array<MessageCreate | ApprovalCreate>,
): boolean {
  return input.some(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      item.type !== "approval" &&
      "role" in item &&
      item.role === "user",
  );
}

function isTurnInputArray(
  value: unknown,
): value is Array<MessageCreate | ApprovalCreate> {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "object" && item !== null)
  );
}

type ConversationLoopContext = {
  abortControllerRef: MutableRefObject<AbortController | null>;
  agentIdRef: MutableRefObject<string>;
  appendError: AppendError;
  appendTaskNotificationEvents: (summaries: string[]) => boolean;
  approvalToolContextIdRef: MutableRefObject<string | null>;
  autoAllowedExecutionRef: MutableRefObject<AutoAllowedExecution | null>;
  buffersRef: MutableRefObject<Buffers>;
  clearApprovalToolContext: () => void;
  closeTrajectorySegment: () => void;
  consumeQueuedMessages: () => QueuedMessage[] | null;
  queueModeRef: MutableRefObject<"immediate" | "defer">;
  contextTrackerRef: MutableRefObject<ContextTracker>;
  chatgptPlanSwapsRef: MutableRefObject<number>;
  chatgptExhaustedProvidersRef: MutableRefObject<Set<string>>;
  conversationBusyRetriesRef: MutableRefObject<number>;
  conversationGenerationRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string>;
  currentModelId: string | null;
  emptyResponseRetriesRef: MutableRefObject<number>;
  executingToolCallIdsRef: MutableRefObject<string[]>;
  generateConversationDescription: (options?: {
    force?: boolean;
  }) => Promise<void>;
  modAdapter: LocalModAdapter;
  generateConversationTitle: () => Promise<string | null>;
  hasConversationModelOverrideRef: MutableRefObject<boolean>;
  interruptQueuedRef: MutableRefObject<boolean>;
  isAutoConversationTitleInFlightRef: MutableRefObject<boolean>;
  lastDequeuedMessageRef: MutableRefObject<string | null>;
  lastRunIdRef: MutableRefObject<string | null>;
  lastSentInputRef: MutableRefObject<Array<
    MessageCreate | ApprovalCreate
  > | null>;
  llmApiErrorRetriesRef: MutableRefObject<number>;
  llmConfigRef: MutableRefObject<LlmConfig | null>;
  maybeRunPostTurnReflection: () => Promise<void>;
  needsEagerApprovalCheck: boolean;
  openTrajectorySegment: () => void;
  pendingInterruptRecoveryConversationIdRef: MutableRefObject<string | null>;
  pendingTranscriptStartLineIndexRef: MutableRefObject<number | null>;
  precomputedDiffsRef: MutableRefObject<Map<string, AdvancedDiffSuccess>>;
  prepareScopedToolExecutionContext: (
    overrideModel?: string | null,
  ) => Promise<PreparedScopeToolContext>;
  processingConversationRef: MutableRefObject<number>;
  queuedApprovalResultsRef: MutableRefObject<ApprovalResult[] | null>;
  queueApprovalResults: QueueApprovalResults;
  queueSnapshotRef: MutableRefObject<QueuedMessage[]>;
  refreshDerived: () => void;
  refreshDerivedThrottled: () => void;
  resetTrajectoryBases: () => void;
  restoreQueueOnCancelRef: MutableRefObject<boolean>;
  sessionStatsRef: MutableRefObject<SessionStats>;
  setAgentDescription: Dispatch<SetStateAction<string | null>>;
  setAgentLastRunAt: Dispatch<SetStateAction<string | null>>;
  setAgentState: Dispatch<SetStateAction<AgentState | null | undefined>>;
  setApprovalContexts: Dispatch<SetStateAction<ApprovalContext[]>>;
  setApprovalResults: Dispatch<SetStateAction<ApprovalDecision[]>>;
  setAutoDeniedApprovals: Dispatch<SetStateAction<AutoDeniedApproval[]>>;
  setAutoHandledResults: Dispatch<SetStateAction<AutoHandledToolResult[]>>;
  setCurrentModelHandle: Dispatch<SetStateAction<string | null>>;
  setCurrentModelId: Dispatch<SetStateAction<string | null>>;
  setDequeueEpoch: Dispatch<SetStateAction<number>>;
  setInterruptRequested: Dispatch<SetStateAction<boolean>>;
  lastStopReasonRef: MutableRefObject<string | null>;
  setIsExecutingTool: Dispatch<SetStateAction<boolean>>;
  setLlmConfig: Dispatch<SetStateAction<LlmConfig | null>>;
  setNeedsEagerApprovalCheck: Dispatch<SetStateAction<boolean>>;
  setNetworkPhase: Dispatch<SetStateAction<NetworkPhase>>;
  setExecutionPhase: Dispatch<SetStateAction<ExecutionPhase>>;
  setPendingApprovals: Dispatch<SetStateAction<ApprovalRequest[]>>;
  setRestoreQueueOnCancel: Dispatch<SetStateAction<boolean>>;
  setRestoredInput: Dispatch<SetStateAction<string | null>>;
  setStreaming: (value: boolean) => void;
  setConversationSummary: (summary: string | null) => void;
  setTempModelOverride: (next: string | null) => void;
  setThinkingMessage: Dispatch<SetStateAction<string>>;
  setTrajectoryElapsedBaseMs: Dispatch<SetStateAction<number>>;
  setTrajectoryTokenBase: Dispatch<SetStateAction<number>>;
  setUiPermissionMode: (mode: PermissionMode) => void;
  shouldAutoGenerateConversationTitleRef: MutableRefObject<boolean>;
  syncTrajectoryElapsedBase: () => void;
  syncTrajectoryTokenBase: () => void;
  tempModelOverrideRef: MutableRefObject<string | null>;
  toolAbortControllerRef: MutableRefObject<AbortController | null>;
  toolResultsInFlightRef: MutableRefObject<boolean>;
  trajectoryRunTokenStartRef: MutableRefObject<number>;
  trajectorySegmentStartRef: MutableRefObject<number | null>;
  trajectoryTokenDisplayRef: MutableRefObject<number>;
  tuiQueueRef: MutableRefObject<QueueRuntime | null>;
  uiPermissionModeRef: MutableRefObject<PermissionMode>;
  updateStreamingOutput: (
    toolCallId: string,
    chunk: string,
    isStderr?: boolean,
  ) => void;
  userCancelledRef: MutableRefObject<boolean>;
  waitingForQueueCancelRef: MutableRefObject<boolean>;
};

export function useConversationLoop(ctx: ConversationLoopContext) {
  const {
    abortControllerRef,
    agentIdRef,
    appendError,
    appendTaskNotificationEvents,
    approvalToolContextIdRef,
    autoAllowedExecutionRef,
    buffersRef,
    clearApprovalToolContext,
    closeTrajectorySegment,
    chatgptPlanSwapsRef,
    chatgptExhaustedProvidersRef,
    consumeQueuedMessages,
    queueModeRef,
    contextTrackerRef,
    conversationBusyRetriesRef,
    conversationGenerationRef,
    conversationIdRef,
    currentModelId,
    emptyResponseRetriesRef,
    executingToolCallIdsRef,
    generateConversationDescription,
    modAdapter,
    generateConversationTitle,
    hasConversationModelOverrideRef,
    interruptQueuedRef,
    isAutoConversationTitleInFlightRef,
    lastDequeuedMessageRef,
    lastRunIdRef,
    lastSentInputRef,
    llmApiErrorRetriesRef,
    llmConfigRef,
    maybeRunPostTurnReflection,
    needsEagerApprovalCheck,
    openTrajectorySegment,
    pendingInterruptRecoveryConversationIdRef,
    pendingTranscriptStartLineIndexRef,
    precomputedDiffsRef,
    prepareScopedToolExecutionContext,
    processingConversationRef,
    queuedApprovalResultsRef,
    queueApprovalResults,
    queueSnapshotRef,
    refreshDerived,
    refreshDerivedThrottled,
    resetTrajectoryBases,
    restoreQueueOnCancelRef,
    sessionStatsRef,
    setAgentDescription,
    setAgentLastRunAt,
    setAgentState,
    setApprovalContexts,
    setApprovalResults,
    setAutoDeniedApprovals,
    setAutoHandledResults,
    setCurrentModelHandle,
    setCurrentModelId,
    setDequeueEpoch,
    setInterruptRequested,
    lastStopReasonRef,
    setIsExecutingTool,
    setLlmConfig,
    setNeedsEagerApprovalCheck,
    setNetworkPhase,
    setExecutionPhase,
    setPendingApprovals,
    setRestoreQueueOnCancel,
    setRestoredInput,
    setStreaming,
    setConversationSummary,
    setThinkingMessage,
    setTrajectoryElapsedBaseMs,
    setTrajectoryTokenBase,
    setUiPermissionMode,
    shouldAutoGenerateConversationTitleRef,
    syncTrajectoryElapsedBase,
    syncTrajectoryTokenBase,
    tempModelOverrideRef,
    toolAbortControllerRef,
    toolResultsInFlightRef,
    trajectoryRunTokenStartRef,
    trajectorySegmentStartRef,
    trajectoryTokenDisplayRef,
    tuiQueueRef,
    uiPermissionModeRef,
    updateStreamingOutput,
    userCancelledRef,
    waitingForQueueCancelRef,
  } = ctx;

  const maybeStreamSyntheticNoModelResponse = useCallback(
    async (
      currentInput: Array<MessageCreate | ApprovalCreate>,
      allowReentry: boolean,
      hasApprovalInput: boolean,
    ): Promise<boolean> => {
      const backend = getBackend();
      if (
        !backend.capabilities.localModelCatalog ||
        allowReentry ||
        hasApprovalInput
      ) {
        return false;
      }

      const hasUserMessage = currentInput.some(
        (item) => item.type === "message" && item.role === "user",
      );
      if (!hasUserMessage) {
        return false;
      }

      const availableModels = await getAvailableModelHandles({
        forceRefresh: true,
      });
      if (availableModels.handles.size > 0) {
        return false;
      }

      const currentSettings =
        await settingsManager.getSettingsWithSecureTokens();
      const hasCloudAuth = Boolean(
        process.env.LETTA_API_KEY ||
          currentSettings.refreshToken ||
          currentSettings.env?.LETTA_API_KEY,
      );

      setThinkingMessage(getRandomThinkingVerb());
      await sleep(250);

      const lineId = uid("assistant");
      buffersRef.current.byId.set(lineId, {
        kind: "assistant",
        id: lineId,
        text: "",
        phase: "streaming",
      });
      buffersRef.current.order.push(lineId);
      refreshDerived();

      const chunks = splitSyntheticAssistantResponse(
        buildLocalNoModelResponse(hasCloudAuth),
      );
      for (const chunk of chunks) {
        if (abortControllerRef.current?.signal.aborted) {
          break;
        }

        const currentLine = buffersRef.current.byId.get(lineId);
        if (!currentLine || currentLine.kind !== "assistant") {
          break;
        }

        buffersRef.current.byId.set(lineId, {
          ...currentLine,
          text: currentLine.text + chunk,
        });
        buffersRef.current.tokenCount += Buffer.byteLength(chunk, "utf8");
        refreshDerived();
        await sleep(chunk === "\n" ? 70 : 120);
      }

      const finalLine = buffersRef.current.byId.get(lineId);
      if (finalLine && finalLine.kind === "assistant") {
        buffersRef.current.byId.set(lineId, {
          ...finalLine,
          phase: "finished",
        });
      }
      setNetworkPhase(null);
      setExecutionPhase(null);
      setStreaming(false);
      refreshDerived();
      return true;
    },
    [
      abortControllerRef,
      buffersRef,
      refreshDerived,
      setNetworkPhase,
      setExecutionPhase,
      setStreaming,
      setThinkingMessage,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: blanket suppression — this callback has ~16 omitted deps (refs, stable functions, etc.). Refs are safe (read .current dynamically), but the blanket ignore also hides any genuinely missing reactive deps. If stale-closure bugs appear in processConversation, audit the dep array here first.
  const processConversation = useCallback(
    async (
      initialInput: Array<MessageCreate | ApprovalCreate>,
      options?: import("./types").ProcessConversationOptions,
    ): Promise<void> => {
      const pinnedPermissionMode = uiPermissionModeRef.current;
      const restorePinnedPermissionMode = () => {
        if (permissionMode.getMode() !== pinnedPermissionMode) {
          permissionMode.setMode(pinnedPermissionMode);
        }
        if (uiPermissionModeRef.current !== pinnedPermissionMode) {
          setUiPermissionMode(pinnedPermissionMode);
        }
      };

      buffersRef.current.approvalsPending = false;
      if (buffersRef.current.serverToolCalls.size > 0) {
        let didPromote = false;
        for (const [toolCallId, toolInfo] of buffersRef.current
          .serverToolCalls) {
          const lineId = buffersRef.current.toolCallIdToLineId.get(toolCallId);
          if (!lineId) continue;
          const line = buffersRef.current.byId.get(lineId);
          if (!line || line.kind !== "tool_call" || line.phase === "finished") {
            continue;
          }
          const argsCandidate = toolInfo.toolArgs ?? "";
          const trimmed = argsCandidate.trim();
          let argsComplete = false;
          if (trimmed.length === 0) {
            argsComplete = true;
          } else {
            try {
              JSON.parse(argsCandidate);
              argsComplete = true;
            } catch {}
          }
          if (argsComplete && line.phase !== "running") {
            const nextLine = {
              ...line,
              phase: "running" as const,
              argsText: line.argsText ?? argsCandidate,
            };
            buffersRef.current.byId.set(lineId, nextLine);
            didPromote = true;
          }
        }
        if (didPromote) {
          refreshDerived();
        }
      }
      const inputList = Array.isArray(initialInput) ? initialInput : [];
      let currentInput = [...inputList];
      const allowReentry = options?.allowReentry ?? false;

      const myGeneration =
        options?.submissionGeneration ?? conversationGenerationRef.current;

      if (myGeneration !== conversationGenerationRef.current) {
        return;
      }

      if (processingConversationRef.current > 0 && !allowReentry) {
        return;
      }
      if (options?.clientPreferences !== undefined)
        replaceClientPreferences(
          agentIdRef.current,
          conversationIdRef.current,
          options.clientPreferences,
        );
      processingConversationRef.current += 1;
      let turnStartCancelReason: string | null = null;

      if (hasUserMessageInput(currentInput)) {
        const originalInput = currentInput;
        try {
          const turnStartEvent = {
            agentId: agentIdRef.current ?? null,
            conversationId: conversationIdRef.current ?? null,
            input: currentInput,
          };
          await modAdapter.events.emit(
            "turn_start",
            turnStartEvent,
            modAdapter.context,
          );
          currentInput = isTurnInputArray(turnStartEvent.input)
            ? turnStartEvent.input
            : originalInput;
          turnStartCancelReason =
            getTurnStartCancel(turnStartEvent)?.reason ?? null;
        } catch {
          currentInput = originalInput;
          turnStartCancelReason = null;
        }
      }

      const hasApprovalInput = currentInput.some(
        (item) => item.type === "approval",
      );
      const hasExplicitTranscriptStart =
        options?.transcriptStartLineIndex !== undefined;
      if (options?.transcriptStartLineIndex !== undefined) {
        pendingTranscriptStartLineIndexRef.current =
          options.transcriptStartLineIndex;
      } else if (!hasApprovalInput) {
        pendingTranscriptStartLineIndexRef.current = null;
      }
      const transcriptTurnStartLineIndex =
        hasExplicitTranscriptStart || hasApprovalInput
          ? pendingTranscriptStartLineIndexRef.current
          : null;

      if (!allowReentry) {
        llmApiErrorRetriesRef.current = 0;
        emptyResponseRetriesRef.current = 0;
        conversationBusyRetriesRef.current = 0;
        chatgptPlanSwapsRef.current = 0;
        chatgptExhaustedProvidersRef.current.clear();
      }

      let currentRunId: string | undefined;
      let preserveTranscriptStartForApproval = false;
      let turnAbortController: AbortController | null = null;
      let conversationBusyDeadlineMs: number | null = null;
      try {
        if (turnStartCancelReason) {
          const statusId = uid("status");
          buffersRef.current.byId.set(statusId, {
            kind: "status",
            id: statusId,
            lines: [turnStartCancelReason],
          });
          buffersRef.current.order.push(statusId);
          refreshDerived();
          userCancelledRef.current = false;
          return;
        }

        if (userCancelledRef.current) {
          userCancelledRef.current = false;
          return;
        }

        if (myGeneration !== conversationGenerationRef.current) {
          return;
        }

        setStreaming(true);
        openTrajectorySegment();
        setNetworkPhase("upload");
        setExecutionPhase("requesting");
        turnAbortController = new AbortController();
        abortControllerRef.current = turnAbortController;

        if (
          await maybeStreamSyntheticNoModelResponse(
            currentInput,
            allowReentry,
            hasApprovalInput,
          )
        ) {
          return;
        }

        const originalInput = currentInput;
        const cacheIsAllUserMsgs = lastSentInputRef.current?.every(
          (m: MessageCreate | ApprovalCreate) =>
            m.type === "message" && m.role === "user",
        );
        const canInjectInterruptRecovery =
          pendingInterruptRecoveryConversationIdRef.current !== null &&
          pendingInterruptRecoveryConversationIdRef.current ===
            conversationIdRef.current;
        if (
          cacheIsAllUserMsgs &&
          lastSentInputRef.current &&
          canInjectInterruptRecovery
        ) {
          currentInput = [
            ...lastSentInputRef.current.map(
              (m: MessageCreate | ApprovalCreate) => ({
                ...m,
                otid: randomUUID(),
              }),
            ),
            ...currentInput.map((m) =>
              m.type === "message" && m.role === "user"
                ? {
                    ...m,
                    otid: randomUUID(),
                    content: [
                      { type: "text" as const, text: INTERRUPT_RECOVERY_ALERT },
                      ...(typeof m.content === "string"
                        ? [{ type: "text" as const, text: m.content }]
                        : Array.isArray(m.content)
                          ? m.content
                          : []),
                    ],
                  }
                : { ...m, otid: randomUUID() },
            ),
          ];
          pendingInterruptRecoveryConversationIdRef.current = null;
          lastSentInputRef.current = [
            ...lastSentInputRef.current,
            ...originalInput,
          ];
        } else {
          pendingInterruptRecoveryConversationIdRef.current = null;
          lastSentInputRef.current = originalInput;
        }

        if (!allowReentry) {
          markIncompleteToolsAsCancelled(
            buffersRef.current,
            false,
            "internal_cancel",
          );
        }
        buffersRef.current.interrupted = false;

        if (
          shouldClearCompletedSubagentsOnTurnStart(
            allowReentry,
            hasActiveSubagents(),
          )
        ) {
          clearCompletedSubagents();
        }

        let streamSequenceCursor: StreamSequenceCursor | null = null;

        while (true) {
          const signal = abortControllerRef.current?.signal;

          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          const { consumeQueuedSkillContent } = await import(
            "@/tools/impl/skill-content-registry"
          );
          const skillContents = consumeQueuedSkillContent();
          if (skillContents.length > 0) {
            currentInput = [
              ...currentInput,
              {
                role: "user",
                content: skillContents.map((sc) => ({
                  type: "text" as const,
                  text: sc.content,
                })),
                otid: randomUUID(),
              },
            ];
          }

          let stream: Awaited<ReturnType<typeof sendMessageStream>> | null =
            null;
          let turnToolContextId: string | null = null;
          let prefetchedAgent: AgentState | null = null;
          try {
            const preparedToolContext = await prepareScopedToolExecutionContext(
              tempModelOverrideRef.current ?? undefined,
            );
            prefetchedAgent = preparedToolContext.agent;
            const nextStream = await sendMessageStream(
              conversationIdRef.current,
              currentInput,
              {
                agentId: agentIdRef.current,
                overrideModel: tempModelOverrideRef.current ?? undefined,
                preparedToolContext: preparedToolContext.preparedToolContext,
                allowResponseStateReuse:
                  options?.allowResponseStateReuse === true,
              },
              { maxRetries: 0, signal },
            );
            stream = nextStream;
            turnToolContextId = getStreamToolContextId(nextStream);
          } catch (preStreamError) {
            debugLog(
              "stream",
              "Pre-stream error: %s (status=%s)",
              preStreamError instanceof Error
                ? preStreamError.message
                : String(preStreamError),
              preStreamError instanceof APIError
                ? preStreamError.status
                : "none",
            );

            const errorDetail = extractConflictDetail(preStreamError);

            const preStreamAction = getPreStreamErrorAction(
              errorDetail,
              conversationBusyRetriesRef.current,
              CONVERSATION_BUSY_MAX_RETRIES,
              {
                status:
                  preStreamError instanceof APIError
                    ? preStreamError.status
                    : undefined,
                transientRetries: llmApiErrorRetriesRef.current,
                maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
              },
            );

            if (
              shouldAttemptApprovalRecovery({
                approvalPendingDetected:
                  preStreamAction === "resolve_approval_pending",
                retries: llmApiErrorRetriesRef.current,
                maxRetries: LLM_API_ERROR_MAX_RETRIES,
              })
            ) {
              llmApiErrorRetriesRef.current += 1;
              try {
                const agent = await getBackend().retrieveAgent(
                  agentIdRef.current,
                );
                const { pendingApprovals: existingApprovals } =
                  await getResumeDataFromBackend(
                    agent,
                    conversationIdRef.current,
                  );
                currentInput = rebuildInputWithFreshDenials(
                  currentInput,
                  existingApprovals ?? [],
                  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
                );
              } catch {
                currentInput = rebuildInputWithFreshDenials(
                  currentInput,
                  [],
                  "",
                );
              }
              buffersRef.current.interrupted = false;
              continue;
            }

            const blockingRunId = extractConversationBusyRunId(errorDetail);
            if (
              preStreamAction === "retry_conversation_busy" ||
              blockingRunId
            ) {
              telemetry.trackError(
                "retry_conversation_busy",
                formatTelemetryErrorMessage(
                  errorDetail || "Conversation is busy",
                ),
                "pre_stream_retry",
                {
                  httpStatus:
                    preStreamError instanceof APIError
                      ? preStreamError.status
                      : undefined,
                  modelId: currentModelId || undefined,
                },
              );
              const resumeStream = await resumeConversationBusyRequest(
                conversationIdRef.current ?? "default",
                agentIdRef.current ?? undefined,
                currentInput,
                signal,
              );
              if (resumeStream) {
                buffersRef.current.interrupted = false;
                stream = resumeStream as Awaited<
                  ReturnType<typeof sendMessageStream>
                >;
                turnToolContextId = getStreamToolContextId(stream);
              } else {
                debugLog(
                  "stream",
                  "Pre-stream OTID resume unavailable; falling back to blocker wait or retry",
                );
              }
              if (!stream) {
                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: [
                    blockingRunId
                      ? `Conversation is busy; waiting for run ${blockingRunId} to finish…`
                      : "Conversation is busy, waiting and retrying…",
                  ],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();
                if (blockingRunId) {
                  conversationBusyDeadlineMs ??=
                    Date.now() + CONVERSATION_BUSY_WAIT_TIMEOUT_MS;
                  let settled: boolean;
                  try {
                    settled = await waitForConversationBusyRunOrThrow(
                      blockingRunId,
                      signal,
                      conversationBusyDeadlineMs,
                    );
                  } finally {
                    buffersRef.current.byId.delete(statusId);
                    buffersRef.current.order = buffersRef.current.order.filter(
                      (id: string) => id !== statusId,
                    );
                    refreshDerived();
                  }
                  if (settled) {
                    if (
                      myGeneration !== conversationGenerationRef.current ||
                      userCancelledRef.current
                    )
                      return;
                    buffersRef.current.interrupted = false;
                    restorePinnedPermissionMode();
                    continue;
                  }
                }
                if (preStreamAction === "retry_conversation_busy") {
                  conversationBusyRetriesRef.current += 1;
                  const retryDelayMs = getRetryDelayMs({
                    category: "conversation_busy",
                    attempt: conversationBusyRetriesRef.current,
                  });
                  let cancelled = false;
                  const startTime = Date.now();
                  while (Date.now() - startTime < retryDelayMs) {
                    if (
                      abortControllerRef.current?.signal.aborted ||
                      userCancelledRef.current
                    ) {
                      cancelled = true;
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                  }
                  if (!blockingRunId) {
                    buffersRef.current.byId.delete(statusId);
                    buffersRef.current.order = buffersRef.current.order.filter(
                      (id: string) => id !== statusId,
                    );
                    refreshDerived();
                  }
                  if (!cancelled) {
                    buffersRef.current.interrupted = false;
                    restorePinnedPermissionMode();
                    continue;
                  }
                }
              }
            }
            if (preStreamAction === "retry_transient") {
              llmApiErrorRetriesRef.current += 1;
              const attempt = llmApiErrorRetriesRef.current;
              const retryAfterMs =
                preStreamError instanceof APIError
                  ? parseRetryAfterHeaderMs(
                      preStreamError.headers?.get("retry-after"),
                    )
                  : null;
              const delayMs = getRetryDelayMs({
                category: "transient_provider",
                attempt,
                detail: errorDetail,
                retryAfterMs,
              });

              telemetry.trackError(
                "retry_pre_stream_transient",
                formatTelemetryErrorMessage(
                  errorDetail || "Pre-stream transient error",
                ),
                "pre_stream_retry",
                {
                  httpStatus:
                    preStreamError instanceof APIError
                      ? preStreamError.status
                      : undefined,
                  modelId: currentModelId || undefined,
                },
              );

              const retryStatusMsg = getRetryStatusMessage(errorDetail);
              const retryStatusId =
                retryStatusMsg != null ? uid("status") : null;
              if (retryStatusId && retryStatusMsg) {
                buffersRef.current.byId.set(retryStatusId, {
                  kind: "status",
                  id: retryStatusId,
                  lines: [retryStatusMsg],
                });
                buffersRef.current.order.push(retryStatusId);
                refreshDerived();
              }

              let cancelled = false;
              const startTime = Date.now();
              while (Date.now() - startTime < delayMs) {
                if (
                  abortControllerRef.current?.signal.aborted ||
                  userCancelledRef.current
                ) {
                  cancelled = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 100));
              }

              if (retryStatusId) {
                buffersRef.current.byId.delete(retryStatusId);
                buffersRef.current.order = buffersRef.current.order.filter(
                  (id: string) => id !== retryStatusId,
                );
                refreshDerived();
              }

              if (!cancelled) {
                buffersRef.current.interrupted = false;
                conversationBusyRetriesRef.current = 0;
                restorePinnedPermissionMode();
                continue;
              }
            }

            conversationBusyRetriesRef.current = 0;

            const hasApprovalInPayload = currentInput.some(
              (item) => item?.type === "approval",
            );

            if (hasApprovalInPayload) {
              if (isInvalidToolCallIdsError(errorDetail)) {
                try {
                  const agent = await getBackend().retrieveAgent(
                    agentIdRef.current,
                  );
                  const { pendingApprovals: serverApprovals } =
                    await getResumeDataFromBackend(
                      agent,
                      conversationIdRef.current,
                    );

                  if (serverApprovals && serverApprovals.length > 0) {
                    const textToRestore = getRestorableUserText(currentInput);
                    if (textToRestore) setRestoredInput(textToRestore);

                    setApprovalResults([]);
                    setAutoHandledResults([]);
                    setAutoDeniedApprovals([]);
                    setApprovalContexts([]);
                    queueApprovalResults(null);

                    setPendingApprovals(serverApprovals);

                    try {
                      const contexts = await Promise.all(
                        serverApprovals.map(async (approval) => {
                          const parsedArgs = safeJsonParseOr<
                            Record<string, unknown>
                          >(approval.toolArgs, {});
                          return await analyzeToolApproval(
                            approval.toolName,
                            parsedArgs,
                          );
                        }),
                      );
                      setApprovalContexts(contexts);
                    } catch {}

                    setStreaming(false);
                    sendDesktopNotification("Approval needed");
                    return;
                  }
                  const plainInput = rebuildInputWithFreshDenials(
                    currentInput,
                    [],
                    "",
                  );
                  if (
                    plainInput.length > 0 &&
                    llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
                  ) {
                    llmApiErrorRetriesRef.current += 1;
                    currentInput = plainInput;
                    buffersRef.current.interrupted = false;
                    continue;
                  }
                } catch {}
              }
            }

            if (!stream) {
              reportBusyRetryExhausted(
                errorDetail,
                conversationBusyRetriesRef.current,
                CONVERSATION_BUSY_MAX_RETRIES,
              );
              throw preStreamError;
            }
          }

          conversationBusyDeadlineMs = null;
          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          const syncAgentState = async () => {
            try {
              const agent =
                prefetchedAgent ??
                (await getBackend().retrieveAgent(agentIdRef.current));

              const currentModel = llmConfigRef.current?.model;
              const currentEndpoint = llmConfigRef.current?.model_endpoint_type;
              const currentEffort = llmConfigRef.current?.reasoning_effort;
              const currentEnableReasoner = (
                llmConfigRef.current as unknown as {
                  enable_reasoner?: boolean | null;
                }
              )?.enable_reasoner;

              const agentModel = agent.llm_config.model;
              const agentEndpoint = agent.llm_config.model_endpoint_type;
              const agentEffort = agent.llm_config.reasoning_effort;
              const agentEnableReasoner = (
                agent.llm_config as unknown as {
                  enable_reasoner?: boolean | null;
                }
              )?.enable_reasoner;

              if (
                currentModel !== agentModel ||
                currentEndpoint !== agentEndpoint ||
                currentEffort !== agentEffort ||
                currentEnableReasoner !== agentEnableReasoner
              ) {
                if (!hasConversationModelOverrideRef.current) {
                  setLlmConfig(agent.llm_config);

                  const agentModelHandle = getPreferredAgentModelHandle(agent);

                  const modelInfo = getModelInfoForLlmConfig(
                    agentModelHandle || "",
                    agent.llm_config as unknown as {
                      reasoning_effort?: string | null;
                      enable_reasoner?: boolean | null;
                    },
                  );
                  if (modelInfo) {
                    setCurrentModelId(modelInfo.id);
                  } else {
                    setCurrentModelId(agentModelHandle || null);
                  }
                  setCurrentModelHandle(agentModelHandle || null);
                }

                setAgentState(agent);
                setAgentDescription(agent.description ?? null);
                const lastRunCompletion = (
                  agent as { last_run_completion?: string }
                ).last_run_completion;
                setAgentLastRunAt(lastRunCompletion ?? null);
              }
            } catch (error) {
              debugLog("sync-agent", "Failed to sync agent state: %O", error);
            }
          };

          const isAutoApprovalMode = pinnedPermissionMode === "unrestricted";
          const isUserInitiated = currentInput.some(
            (item) => item.type === "message" && item.role === "user",
          );
          const handleFirstMessage = () => {
            setNetworkPhase("download");
            if (isUserInitiated || !isAutoApprovalMode) {
              void syncAgentState();
            }
          };

          const runTokenStart = buffersRef.current.tokenCount;
          trajectoryRunTokenStartRef.current = runTokenStart;
          sessionStatsRef.current.startTrajectory();

          const hasUserMessage = currentInput.some(
            (item) => item.type === "message",
          );
          if (hasUserMessage) {
            contextTrackerRef.current.currentTurnId++;
          }

          if (!stream) throw new Error("Expected a stream after recovery");
          const drainResult = drainStreamWithResume(
            stream,
            buffersRef.current,
            refreshDerivedThrottled,
            signal,
            handleFirstMessage,
            makeExecutionPhaseHook(setExecutionPhase),
            contextTrackerRef.current,
            streamSequenceCursor,
          );

          const {
            stopReason,
            approval,
            approvals,
            apiDurationMs,
            lastRunId,
            lastSeqId,
            fallbackError,
            errorInfo: streamErrorInfo,
          } = await drainResult;

          streamSequenceCursor = advanceStreamSequenceCursor(
            streamSequenceCursor,
            lastRunId,
            lastSeqId,
          );

          currentRunId = lastRunId ?? undefined;
          if (lastRunId) lastRunIdRef.current = lastRunId;

          sessionStatsRef.current.endTurn(apiDurationMs);
          const usageDelta = sessionStatsRef.current.updateUsageFromBuffers(
            buffersRef.current,
          );
          const tokenDelta = Math.max(
            0,
            buffersRef.current.tokenCount - runTokenStart,
          );
          sessionStatsRef.current.accumulateTrajectory({
            apiDurationMs,
            usageDelta,
            tokenDelta,
          });
          syncTrajectoryTokenBase();

          const wasInterrupted = !!buffersRef.current.interrupted;
          const wasAborted = !!signal?.aborted;
          let stopReasonToHandle = wasAborted ? "cancelled" : stopReason;

          const isStaleAfterDrain =
            myGeneration !== conversationGenerationRef.current;

          if (isStaleAfterDrain) {
            return;
          }

          if (!wasInterrupted) {
            refreshDerived();
          }

          if (wasInterrupted && stopReasonToHandle === "requires_approval") {
            stopReasonToHandle = "cancelled";
          }

          const approvalsFromStream =
            approvals && approvals.length > 0
              ? approvals
              : approval
                ? [approval]
                : [];
          if (
            stopReasonToHandle === "end_turn" &&
            approvalsFromStream.length > 0
          ) {
            telemetry.trackError(
              "stream_end_turn_with_pending_approvals_tui_guard",
              "Stream returned end_turn after emitting approval_request_message chunks; continuing approval flow",
              "message_stream",
              { runId: lastRunId ?? undefined },
            );
            debugWarn(
              "stream",
              "Coercing end_turn to requires_approval because %d approval chunk(s) were collected",
              approvalsFromStream.length,
            );
            stopReasonToHandle = "requires_approval";
          }

          lastStopReasonRef.current = stopReasonToHandle;

          if (stopReasonToHandle === "end_turn") {
            clearApprovalToolContext();
            setStreaming(false);
            const liveElapsedMs = (() => {
              const snapshot = sessionStatsRef.current.getTrajectorySnapshot();
              const base = snapshot?.wallMs ?? 0;
              const segmentStart = trajectorySegmentStartRef.current;
              if (segmentStart === null) {
                return base;
              }
              return base + (performance.now() - segmentStart);
            })();
            closeTrajectorySegment();
            llmApiErrorRetriesRef.current = 0;
            emptyResponseRetriesRef.current = 0;
            conversationBusyRetriesRef.current = 0;
            lastDequeuedMessageRef.current = null;
            lastSentInputRef.current = null;
            pendingInterruptRecoveryConversationIdRef.current = null;

            if (transcriptTurnStartLineIndex !== null) {
              try {
                const transcriptLines = toLines(buffersRef.current).slice(
                  transcriptTurnStartLineIndex,
                );
                await appendTranscriptDeltaJsonl(
                  agentIdRef.current,
                  conversationIdRef.current,
                  transcriptLines,
                );
              } catch (transcriptError) {
                debugWarn(
                  "memory",
                  `Failed to append transcript delta: ${
                    transcriptError instanceof Error
                      ? transcriptError.message
                      : String(transcriptError)
                  }`,
                );
              }
            }
            pendingTranscriptStartLineIndexRef.current = null;

            await maybeRunPostTurnReflection();

            const bufferedLines = Array.from(
              buffersRef.current.byId.values(),
            ) as Line[];
            const lastAssistant = bufferedLines.findLast(
              (item) => item.kind === "assistant" && "text" in item,
            );
            const assistantMessage =
              lastAssistant && "text" in lastAssistant
                ? lastAssistant.text
                : undefined;
            const lastUser = bufferedLines.findLast(
              (item) => item.kind === "user" && "text" in item,
            );
            const userMessage =
              lastUser && "text" in lastUser ? lastUser.text : undefined;
            const precedingReasoning = buffersRef.current.lastReasoning;
            buffersRef.current.lastReasoning = undefined;

            const stopHookResult = await runStopHooks(
              stopReasonToHandle,
              buffersRef.current.order.length,
              bufferedLines.filter((item) => item.kind === "tool_call").length,
              undefined,
              precedingReasoning,
              assistantMessage,
              userMessage,
            );

            if (stopHookResult.blocked) {
              const stderrOutput = stopHookResult.results
                .map((r) => r.stderr)
                .filter(Boolean)
                .join("\n");
              const feedback = stderrOutput || "Stop hook blocked";
              const hookMessage = `<stop-hook>\n${feedback}\n</stop-hook>`;

              const statusId = uid("status");
              buffersRef.current.byId.set(statusId, {
                kind: "status",
                id: statusId,
                lines: ["Stop hook blocked, continuing conversation."],
              });
              buffersRef.current.order.push(statusId);
              refreshDerived();

              const hookMessageOtid = randomUUID();
              setTimeout(() => {
                processConversation(
                  [
                    {
                      type: "message",
                      role: "user",
                      content: hookMessage,
                      otid: hookMessageOtid,
                    },
                  ],
                  { allowReentry: true },
                );
              }, 0);
              return;
            }

            const turnEndEvent: {
              agentId: string | null;
              conversationId: string | null;
              stopReason: string;
              assistantMessage?: string;
              continue?: string;
            } = {
              agentId: agentIdRef.current ?? null,
              conversationId: conversationIdRef.current ?? null,
              stopReason: stopReasonToHandle,
              assistantMessage,
            };
            let turnEndContinue: string | undefined;
            try {
              await modAdapter.events.emit(
                "turn_end",
                turnEndEvent,
                modAdapter.context,
              );
              turnEndContinue =
                typeof turnEndEvent.continue === "string"
                  ? turnEndEvent.continue
                  : undefined;
            } catch {
              turnEndContinue = undefined;
            }

            if (turnEndContinue) {
              const continueOtid = randomUUID();
              setTimeout(() => {
                processConversation(
                  [
                    {
                      type: "message",
                      role: "user",
                      content: turnEndContinue,
                      otid: continueOtid,
                    },
                  ],
                  { allowReentry: true },
                );
              }, 0);
              return;
            }

            if (needsEagerApprovalCheck) {
              setNeedsEagerApprovalCheck(false);
            }

            if (
              shouldAutoGenerateConversationTitleRef.current &&
              !isAutoConversationTitleInFlightRef.current &&
              conversationIdRef.current !== "default"
            ) {
              isAutoConversationTitleInFlightRef.current = true;
              const titleConversationId = conversationIdRef.current;
              const conversationTitle = await generateConversationTitle();
              if (!conversationTitle) {
                isAutoConversationTitleInFlightRef.current = false;
              } else if (
                !shouldAutoGenerateConversationTitleRef.current ||
                conversationIdRef.current !== titleConversationId
              ) {
                isAutoConversationTitleInFlightRef.current = false;
              } else {
                void getBackend()
                  .updateConversation(titleConversationId, {
                    summary: conversationTitle,
                  })
                  .then(() => {
                    shouldAutoGenerateConversationTitleRef.current = false;
                    setConversationSummary(conversationTitle);
                  })
                  .catch((err) => {
                    if (isDebugEnabled()) {
                      console.error(
                        "[DEBUG] Failed to update conversation title:",
                        err,
                      );
                    }
                  })
                  .finally(() => {
                    isAutoConversationTitleInFlightRef.current = false;
                  });
              }
            }

            if (
              contextTrackerRef.current
                .pendingConversationDescriptionRegeneration
            ) {
              contextTrackerRef.current.pendingConversationDescriptionRegeneration = false;
              void generateConversationDescription({ force: true });
            } else {
              void generateConversationDescription();
            }

            const trajectorySnapshot = sessionStatsRef.current.endTrajectory();
            setTrajectoryTokenBase(0);
            setTrajectoryElapsedBaseMs(0);
            trajectoryRunTokenStartRef.current = 0;
            trajectoryTokenDisplayRef.current = 0;
            if (trajectorySnapshot) {
              const summaryWallMs = Math.max(
                liveElapsedMs,
                trajectorySnapshot.wallMs,
              );
              const shouldShowSummary =
                (trajectorySnapshot.stepCount > 3 && summaryWallMs > 10000) ||
                summaryWallMs > 60000;
              if (shouldShowSummary) {
                const summaryId = uid("trajectory-summary");
                buffersRef.current.byId.set(summaryId, {
                  kind: "trajectory_summary",
                  id: summaryId,
                  durationMs: summaryWallMs,
                  stepCount: trajectorySnapshot.stepCount,
                  verb: getRandomPastTenseVerb(),
                });
                buffersRef.current.order.push(summaryId);
                refreshDerived();
              }
            }

            if (!waitingForQueueCancelRef.current) {
              sendDesktopNotification("Turn completed, awaiting your input");
            }

            if (waitingForQueueCancelRef.current) {
              debugLog(
                "queue",
                "Queue-cancel completed (end_turn): messages will be processed by dequeue effect",
              );
              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            }

            return;
          }

          if (stopReasonToHandle === "cancelled") {
            clearApprovalToolContext();
            pendingTranscriptStartLineIndexRef.current = null;
            setStreaming(false);
            closeTrajectorySegment();
            syncTrajectoryElapsedBase();

            if (waitingForQueueCancelRef.current) {
              debugLog(
                "queue",
                "Queue-cancel completed (cancelled): messages will be processed by dequeue effect",
              );
              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            } else {
              if (!EAGER_CANCEL) {
                appendError(INTERRUPT_MESSAGE, true);
              }
            }

            return;
          }

          if (stopReasonToHandle === "requires_approval") {
            clearApprovalToolContext();
            preserveTranscriptStartForApproval = true;
            approvalToolContextIdRef.current = turnToolContextId;
            setAutoHandledResults([]);
            setAutoDeniedApprovals([]);
            lastSentInputRef.current = null;
            pendingInterruptRecoveryConversationIdRef.current = null;

            const approvalsToProcess = approvalsFromStream;

            if (approvalsToProcess.length === 0) {
              clearApprovalToolContext();
              recordEmptyApprovalTelemetry(lastRunId, streamSequenceCursor);
              appendError(
                `Unexpected empty approvals with stop reason: ${stopReason}`,
              );
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              return;
            }

            if (waitingForQueueCancelRef.current) {
              clearApprovalToolContext();
              const denialResults = approvalsToProcess.map((approvalItem) => ({
                type: "approval" as const,
                tool_call_id: approvalItem.toolCallId,
                approve: false,
                reason: "User cancelled - new message queued",
              }));

              for (const approvalItem of approvalsToProcess) {
                onChunk(buffersRef.current, {
                  message_type: "tool_return_message",
                  id: "dummy",
                  date: new Date().toISOString(),
                  tool_call_id: approvalItem.toolCallId,
                  tool_return: "Cancelled - user sent new message",
                  status: "error",
                });
              }
              refreshDerived();

              queueApprovalResults(denialResults);

              debugLog(
                "queue",
                `Queue-cancel completed (requires_approval): ${denialResults.length} denial(s) queued, messages will be processed by dequeue effect`,
              );

              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              return;
            }

            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              clearApprovalToolContext();
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              markIncompleteToolsAsCancelled(
                buffersRef.current,
                true,
                "user_interrupt",
              );
              refreshDerived();
              return;
            }

            const desiredMode = uiPermissionModeRef.current;
            if (permissionMode.getMode() !== desiredMode) {
              permissionMode.setMode(desiredMode);
            }

            const { needsUserInput, autoAllowed, autoDenied } =
              await classifyApprovals(approvalsToProcess, {
                getContext: analyzeToolApproval,
                requireArgsForAutoApprove: true,
                missingNameReason:
                  "Tool call incomplete - missing name or arguments",
                toolContextId: approvalToolContextIdRef.current,
              });

            for (const ac of [...autoAllowed, ...needsUserInput]) {
              const toolName = ac.approval.toolName;
              const toolCallId = ac.approval.toolCallId;
              try {
                const args = JSON.parse(ac.approval.toolArgs || "{}");

                if (isFileWriteTool(toolName)) {
                  const filePath = args.file_path as string | undefined;
                  if (filePath) {
                    const result = computeAdvancedDiff({
                      kind: "write",
                      filePath,
                      content: (args.content as string) || "",
                    });
                    if (result.mode === "advanced") {
                      precomputedDiffsRef.current.set(toolCallId, result);
                    }
                  }
                } else if (isFileEditTool(toolName)) {
                  const filePath = args.file_path as string | undefined;
                  if (filePath) {
                    const result = computeAdvancedDiff({
                      kind: "edit",
                      filePath,
                      oldString: (args.old_string as string) || "",
                      newString: (args.new_string as string) || "",
                      replaceAll: args.replace_all as boolean | undefined,
                    });
                    if (result.mode === "advanced") {
                      precomputedDiffsRef.current.set(toolCallId, result);
                    }
                  }
                } else if (isPatchTool(toolName) && args.input) {
                  const operations = parsePatchOperations(args.input as string);
                  for (const op of operations) {
                    const key = `${toolCallId}:${op.path}`;
                    if (op.kind === "add" || op.kind === "update") {
                      const result = parsePatchToAdvancedDiff(
                        op.patchLines,
                        op.path,
                      );
                      if (result) {
                        precomputedDiffsRef.current.set(key, result);
                      }
                    }
                  }
                }
              } catch {}
            }

            const autoAllowedToolCallIds = autoAllowed.map(
              (ac) => ac.approval.toolCallId,
            );
            const autoAllowedAbortController =
              abortControllerRef.current ?? new AbortController();
            const shouldTrackAutoAllowed = autoAllowedToolCallIds.length > 0;
            let autoAllowedResults: Array<{
              toolCallId: string;
              result: ToolExecutionResult;
            }> = [];
            const autoDeniedResults: Array<{
              approval: ApprovalRequest;
              reason: string;
            }> = autoDenied.map((ac) => ({
              approval: ac.approval,
              reason: formatPermissionDenial(ac.permission),
            }));
            const prebuiltDeniedApprovalResults =
              buildDeniedResults(autoDeniedResults);

            if (shouldTrackAutoAllowed) {
              setIsExecutingTool(true);
              executingToolCallIdsRef.current = autoAllowedToolCallIds;
              toolAbortControllerRef.current = autoAllowedAbortController;
              autoAllowedExecutionRef.current = {
                toolCallIds: autoAllowedToolCallIds,
                results: null,
                conversationId: conversationIdRef.current,
                generation: conversationGenerationRef.current,
              };
            }

            try {
              if (autoAllowedToolCallIds.length > 0) {
                setToolCallsRunning(buffersRef.current, autoAllowedToolCallIds);
                refreshDerived();
              }

              try {
                const approvalToolContextId =
                  approvalToolContextIdRef.current ??
                  (
                    await prepareScopedToolExecutionContext(
                      tempModelOverrideRef.current ?? undefined,
                    )
                  ).preparedToolContext.contextId;
                autoAllowedResults =
                  autoAllowed.length > 0
                    ? await executeAutoAllowedTools(
                        autoAllowed,
                        (chunk) => onChunk(buffersRef.current, chunk),
                        {
                          abortSignal: autoAllowedAbortController.signal,
                          onStreamingOutput: updateStreamingOutput,
                          toolContextId: approvalToolContextId,
                        },
                      )
                    : [];
              } catch (error) {
                if (
                  shouldTrackAutoAllowed &&
                  toolAbortControllerRef.current !== autoAllowedAbortController
                ) {
                  return;
                }
                appendAbortPartials(error, prebuiltDeniedApprovalResults);
                throw error;
              }

              if (
                shouldTrackAutoAllowed &&
                toolAbortControllerRef.current !== autoAllowedAbortController
              ) {
                return;
              }

              for (const ad of autoDeniedResults) {
                onChunk(buffersRef.current, {
                  message_type: "tool_return_message",
                  id: "dummy",
                  date: new Date().toISOString(),
                  tool_call_id: ad.approval.toolCallId,
                  tool_return: `Error: request to call tool denied. User reason: ${ad.reason}`,
                  status: "error",
                  stdout: null,
                  stderr: null,
                });
              }

              const allResults = [
                ...autoAllowedResults.map((ar) => ({
                  type: "tool" as const,
                  tool_call_id: ar.toolCallId,
                  tool_return: ar.result.toolReturn,
                  status: ar.result.status,
                  stdout: ar.result.stdout,
                  stderr: ar.result.stderr,
                })),
                ...prebuiltDeniedApprovalResults,
              ];

              if (autoAllowedExecutionRef.current) {
                autoAllowedExecutionRef.current.results = allResults;
              }
              const autoAllowedMetadata = autoAllowedExecutionRef.current
                ? {
                    conversationId:
                      autoAllowedExecutionRef.current.conversationId,
                    generation: conversationGenerationRef.current,
                  }
                : undefined;

              if (needsUserInput.length === 0) {
                if (
                  userCancelledRef.current ||
                  abortControllerRef.current?.signal.aborted ||
                  interruptQueuedRef.current
                ) {
                  if (allResults.length > 0) {
                    queueApprovalResults(allResults, autoAllowedMetadata);
                  }
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  markIncompleteToolsAsCancelled(
                    buffersRef.current,
                    true,
                    "user_interrupt",
                  );
                  refreshDerived();
                  return;
                }

                const queuedItemsToAppend =
                  queueModeRef.current === "immediate"
                    ? consumeQueuedMessages()
                    : null;
                const queuedNotifications = queuedItemsToAppend
                  ? getQueuedNotificationSummaries(queuedItemsToAppend)
                  : [];
                appendTaskNotificationEvents(queuedNotifications);
                const queuedTurn = prepareTuiQueuedTurn(
                  queuedItemsToAppend,
                  allResults,
                  buffersRef.current,
                );
                if (queuedTurn.hasQueuedMessage) {
                  setThinkingMessage(getRandomThinkingVerb());
                  refreshDerived();
                  toolResultsInFlightRef.current = true;
                  await processConversation(
                    queuedTurn.input,
                    queuedTurn.options,
                  );
                  toolResultsInFlightRef.current = false;
                  return;
                }

                if (waitingForQueueCancelRef.current) {
                  if (allResults.length > 0) {
                    queueApprovalResults(allResults, autoAllowedMetadata);
                  }

                  debugLog(
                    "queue",
                    `Queue-cancel completed (auto-allowed): ${allResults.length} result(s) queued, messages will be processed by dequeue effect`,
                  );

                  if (restoreQueueOnCancelRef.current) {
                    setRestoreQueueOnCancel(false);
                  }

                  waitingForQueueCancelRef.current = false;
                  queueSnapshotRef.current = [];
                  setStreaming(false);
                  closeTrajectorySegment();
                  syncTrajectoryElapsedBase();
                  return;
                }

                setThinkingMessage(getRandomThinkingVerb());
                refreshDerived();

                toolResultsInFlightRef.current = true;
                await processConversation(
                  [
                    {
                      type: "approval",
                      approvals: allResults,
                      otid: randomUUID(),
                    },
                  ],
                  {
                    allowReentry: true,
                    allowResponseStateReuse: true,
                  },
                );
                toolResultsInFlightRef.current = false;
                return;
              }

              if (waitingForQueueCancelRef.current) {
                const denialResults = needsUserInput.map((ac) => ({
                  type: "approval" as const,
                  tool_call_id: ac.approval.toolCallId,
                  approve: false,
                  reason: "User cancelled - new message queued",
                }));

                for (const ac of needsUserInput) {
                  onChunk(buffersRef.current, {
                    message_type: "tool_return_message",
                    id: "dummy",
                    date: new Date().toISOString(),
                    tool_call_id: ac.approval.toolCallId,
                    tool_return: "Cancelled - user sent new message",
                    status: "error",
                  });
                }
                refreshDerived();

                const queuedResults = [...allResults, ...denialResults];
                if (queuedResults.length > 0) {
                  queueApprovalResults(queuedResults, autoAllowedMetadata);
                }

                debugLog(
                  "queue",
                  `Queue-cancel completed (auto-allowed+approvals): ${queuedResults.length} result(s) queued, messages will be processed by dequeue effect`,
                );

                if (restoreQueueOnCancelRef.current) {
                  setRestoreQueueOnCancel(false);
                }

                waitingForQueueCancelRef.current = false;
                queueSnapshotRef.current = [];
                setStreaming(false);
                closeTrajectorySegment();
                syncTrajectoryElapsedBase();
                return;
              }
            } finally {
              if (
                shouldTrackAutoAllowed &&
                toolAbortControllerRef.current === autoAllowedAbortController
              ) {
                setIsExecutingTool(false);
                toolAbortControllerRef.current = null;
                executingToolCallIdsRef.current = [];
                autoAllowedExecutionRef.current = null;
                toolResultsInFlightRef.current = false;
              }
            }

            if (
              userCancelledRef.current ||
              abortControllerRef.current?.signal.aborted
            ) {
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              markIncompleteToolsAsCancelled(
                buffersRef.current,
                true,
                "user_interrupt",
              );
              refreshDerived();
              return;
            }

            setPendingApprovals(needsUserInput.map((ac) => ac.approval));
            setApprovalContexts(
              needsUserInput
                .map((ac) => ac.context)
                .filter((ctx): ctx is ApprovalContext => ctx !== null),
            );
            setAutoHandledResults(autoAllowedResults);
            setAutoDeniedApprovals(autoDeniedResults);
            setStreaming(false);
            closeTrajectorySegment();
            syncTrajectoryElapsedBase();
            sendDesktopNotification("Approval needed");
            return;
          }

          const hasApprovalInPayload = currentInput.some(
            (item) => item?.type === "approval",
          );

          let latestErrorText: string | null = null;
          for (let i = buffersRef.current.order.length - 1; i >= 0; i -= 1) {
            const id = buffersRef.current.order[i];
            if (!id) continue;
            const entry = buffersRef.current.byId.get(id);
            if (entry?.kind === "error" && typeof entry.text === "string") {
              latestErrorText = entry.text;
              break;
            }
          }

          const runErrorInfo = await fetchRunErrorInfo(lastRunId),
            detailFromRun = runErrorInfo?.detail ?? runErrorInfo?.message;
          const invalidIdsDetected =
            isInvalidToolCallIdsError(detailFromRun) ||
            isInvalidToolCallIdsError(latestErrorText);

          if (hasApprovalInPayload && invalidIdsDetected) {
            try {
              const agent = await getBackend().retrieveAgent(
                agentIdRef.current,
              );
              const { pendingApprovals: serverApprovals } =
                await getResumeDataFromBackend(
                  agent,
                  conversationIdRef.current,
                );

              if (serverApprovals && serverApprovals.length > 0) {
                const textToRestore = getRestorableUserText(currentInput);
                if (textToRestore) setRestoredInput(textToRestore);

                setApprovalResults([]);
                setAutoHandledResults([]);
                setAutoDeniedApprovals([]);
                setApprovalContexts([]);
                queueApprovalResults(null);

                setPendingApprovals(serverApprovals);

                try {
                  const contexts = await Promise.all(
                    serverApprovals.map(async (approval) => {
                      const parsedArgs = safeJsonParseOr<
                        Record<string, unknown>
                      >(approval.toolArgs, {});
                      return await analyzeToolApproval(
                        approval.toolName,
                        parsedArgs,
                      );
                    }),
                  );
                  setApprovalContexts(contexts);
                } catch {}

                setStreaming(false);
                sendDesktopNotification("Approval needed");
                return;
              }
              const plainInput = rebuildInputWithFreshDenials(
                currentInput,
                [],
                "",
              );
              if (
                plainInput.length > 0 &&
                llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
              ) {
                llmApiErrorRetriesRef.current += 1;
                currentInput = plainInput;
                buffersRef.current.interrupted = false;
                continue;
              }
            } catch {}
          }

          const approvalPendingDetected =
            isApprovalPendingError(detailFromRun) ||
            isApprovalPendingError(latestErrorText);

          if (
            shouldAttemptApprovalRecovery({
              approvalPendingDetected,
              retries: llmApiErrorRetriesRef.current,
              maxRetries: LLM_API_ERROR_MAX_RETRIES,
            })
          ) {
            llmApiErrorRetriesRef.current += 1;

            try {
              const agent = await getBackend().retrieveAgent(
                agentIdRef.current,
              );
              const { pendingApprovals: existingApprovals } =
                await getResumeDataFromBackend(
                  agent,
                  conversationIdRef.current,
                );
              currentInput = rebuildInputWithFreshDenials(
                currentInput,
                existingApprovals ?? [],
                STALE_APPROVAL_RECOVERY_DENIAL_REASON,
              );
            } catch {
              currentInput = rebuildInputWithFreshDenials(currentInput, [], "");
            }

            buffersRef.current.interrupted = false;
            continue;
          }

          if (
            chatgptPlanSwapsRef.current <
            CHATGPT_PLAN_ROTATION_MAX_SWAPS_PER_TURN
          ) {
            const rotation = await rotateChatGPTPlanOnQuotaLimit({
              agentId: agentIdRef.current,
              conversationId: conversationIdRef.current,
              currentHandle: currentModelId,
              error: streamErrorInfo ?? runErrorInfo ?? fallbackError,
              exhaustedProviders: chatgptExhaustedProvidersRef.current,
              signal: turnAbortController.signal,
            });
            if (rotation) {
              chatgptPlanSwapsRef.current += 1;
              const statusId = uid("status");
              buffersRef.current.byId.set(statusId, {
                kind: "status",
                id: statusId,
                lines: [formatPlanRotationNotice(rotation)],
              });
              buffersRef.current.order.push(statusId);
              refreshDerived();

              currentInput = refreshInputOtidsForNewRequest(currentInput);
              buffersRef.current.interrupted = false;
              continue;
            }
          }

          if (
            !getBackend().capabilities.localModelCatalog &&
            isQuotaLimitErrorDetail(detailFromRun ?? fallbackError)
          ) {
            appendError(KEY_OR_CREDITS_REQUIRED_MESSAGE, true);
          }

          if (
            isEmptyResponseRetryable(
              stopReasonToHandle === "llm_api_error" ? "llm_error" : undefined,
              detailFromRun,
              emptyResponseRetriesRef.current,
              EMPTY_RESPONSE_MAX_RETRIES,
            )
          ) {
            emptyResponseRetriesRef.current += 1;
            const attempt = emptyResponseRetriesRef.current;
            const delayMs = getRetryDelayMs({
              category: "empty_response",
              attempt,
            });

            if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
              currentInput = [
                ...currentInput,
                {
                  type: "message" as const,
                  role: "user" as const,
                  content: `<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>`,
                  otid: randomUUID(),
                },
              ];
            }

            const statusId = uid("status");
            buffersRef.current.byId.set(statusId, {
              kind: "status",
              id: statusId,
              lines: [
                `Empty LLM response, retrying (attempt ${attempt}/${EMPTY_RESPONSE_MAX_RETRIES})...`,
              ],
            });
            buffersRef.current.order.push(statusId);
            refreshDerived();

            await new Promise((resolve) => setTimeout(resolve, delayMs));

            buffersRef.current.byId.delete(statusId);
            buffersRef.current.order = buffersRef.current.order.filter(
              (id: string) => id !== statusId,
            );
            refreshDerived();

            currentInput = refreshInputOtidsForNewRequest(currentInput);
            buffersRef.current.interrupted = false;
            continue;
          }

          const retriable = await isRetriableError(
            stopReasonToHandle,
            lastRunId,
            detailFromRun ?? latestErrorText ?? fallbackError,
          );

          if (
            retriable &&
            llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
          ) {
            llmApiErrorRetriesRef.current += 1;
            const attempt = llmApiErrorRetriesRef.current;

            const delayMs = getRetryDelayMs({
              category: "transient_provider",
              attempt,
              detail: detailFromRun ?? fallbackError,
            });

            telemetry.trackError(
              "retry_post_stream_error",
              formatTelemetryErrorMessage(
                detailFromRun ||
                  fallbackError ||
                  `Stream stopped: ${stopReasonToHandle}`,
              ),
              "post_stream_retry",
              {
                modelId: currentModelId || undefined,
                runId: lastRunId ?? undefined,
              },
            );

            debugLog(
              "retry",
              "Post-stream retry (run=%s, stop=%s): %s",
              lastRunId ?? "unknown",
              stopReasonToHandle ?? "unknown",
              detailFromRun || fallbackError || "unknown error",
            );
            const retryStatusMsg = getRetryStatusMessage(detailFromRun);
            const retryStatusId = retryStatusMsg != null ? uid("status") : null;
            if (retryStatusId && retryStatusMsg) {
              buffersRef.current.byId.set(retryStatusId, {
                kind: "status",
                id: retryStatusId,
                lines: [retryStatusMsg],
              });
              buffersRef.current.order.push(retryStatusId);
              refreshDerived();
            }

            let cancelled = false;
            const startTime = Date.now();
            while (Date.now() - startTime < delayMs) {
              if (
                abortControllerRef.current?.signal.aborted ||
                userCancelledRef.current
              ) {
                cancelled = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }

            if (retryStatusId) {
              buffersRef.current.byId.delete(retryStatusId);
              buffersRef.current.order = buffersRef.current.order.filter(
                (id: string) => id !== retryStatusId,
              );
              refreshDerived();
            }

            if (!cancelled) {
              const backendCapabilities = getBackend().capabilities;
              const retryFromPersistedLocalState =
                backendCapabilities.localModelCatalog &&
                !backendCapabilities.remoteMemfs;
              currentInput = retryFromPersistedLocalState
                ? []
                : refreshInputOtidsForNewRequest(currentInput);
              streamSequenceCursor = null;
              buffersRef.current.interrupted = false;
              continue;
            }
          }

          llmApiErrorRetriesRef.current = 0;
          emptyResponseRetriesRef.current = 0;
          conversationBusyRetriesRef.current = 0;

          markIncompleteToolsAsCancelled(
            buffersRef.current,
            true,
            "stream_error",
          );

          if (fallbackError && !lastRunId) {
            setNetworkPhase("error");
            setExecutionPhase(null);
            const formattedFallback = formatErrorDetails(
              fallbackError,
              agentIdRef.current,
            );
            const errorMsg = `Stream error: ${formattedFallback}`;
            appendError(errorMsg, {
              errorType: "FallbackError",
              errorMessage: formatTelemetryErrorMessage(fallbackError),
              context: "message_stream",
            });
            appendError(ERROR_FEEDBACK_HINT, true);

            if (lastDequeuedMessageRef.current) {
              setRestoredInput(lastDequeuedMessageRef.current);
              lastDequeuedMessageRef.current = null;
            }
            tuiQueueRef.current?.clear("error");

            setStreaming(false);
            sendDesktopNotification("Stream error", "error");
            refreshDerived();
            resetTrajectoryBases();
            return;
          }

          const errorTelemetryBase = {
            errorType: stopReasonToHandle || "unknown_stop_reason",
            context: "message_stream" as const,
            runId: lastRunId ?? undefined,
          };

          if (lastRunId) {
            try {
              const run = await getBackend().retrieveRun(lastRunId);

              if (run.metadata?.error) {
                const errorData = run.metadata.error as {
                  type?: string;
                  message?: string;
                  detail?: string;
                };

                const serverErrorDetail =
                  errorData.detail || errorData.message || null;

                const errorObject = {
                  error: {
                    error: errorData,
                    run_id: lastRunId,
                  },
                };
                const errorDetails = formatErrorDetails(
                  errorObject,
                  agentIdRef.current,
                );

                appendError(errorDetails, {
                  ...errorTelemetryBase,
                  errorMessage: formatTelemetryErrorMessage(
                    serverErrorDetail ||
                      `Stream stopped with reason: ${stopReasonToHandle}`,
                  ),
                });

                if (
                  !isEncryptedContentError(errorObject) &&
                  !(
                    serverErrorDetail &&
                    isProviderStreamDisconnectErrorText(serverErrorDetail)
                  )
                ) {
                  appendError(
                    getErrorHintForStopReason(
                      stopReasonToHandle,
                      currentModelId,
                      llmConfigRef.current?.model_endpoint_type,
                    ),
                    true,
                  );
                }
              } else {
                appendError(
                  `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`,
                  {
                    ...errorTelemetryBase,
                    errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                  },
                );

                appendError(
                  getErrorHintForStopReason(
                    stopReasonToHandle,
                    currentModelId,
                    llmConfigRef.current?.model_endpoint_type,
                  ),
                  true,
                );
              }
            } catch (_e) {
              appendError(
                `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})\n(Unable to fetch additional error details from server)`,
                {
                  ...errorTelemetryBase,
                  errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                },
              );

              appendError(
                getErrorHintForStopReason(
                  stopReasonToHandle,
                  currentModelId,
                  llmConfigRef.current?.model_endpoint_type,
                ),
                true,
              );

              if (lastDequeuedMessageRef.current) {
                setRestoredInput(lastDequeuedMessageRef.current);
                lastDequeuedMessageRef.current = null;
              }
              tuiQueueRef.current?.clear("error");

              setStreaming(false);
              sendDesktopNotification();
              refreshDerived();
              resetTrajectoryBases();
              return;
            }
          } else {
            appendError(
              `An error occurred during agent execution\n(stop_reason: ${stopReason})`,
              {
                ...errorTelemetryBase,
                errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
              },
            );

            appendError(
              getErrorHintForStopReason(
                stopReasonToHandle,
                currentModelId,
                llmConfigRef.current?.model_endpoint_type,
              ),
              true,
            );
          }

          if (lastDequeuedMessageRef.current) {
            setRestoredInput(lastDequeuedMessageRef.current);
            lastDequeuedMessageRef.current = null;
          }
          tuiQueueRef.current?.clear("error");

          setStreaming(false);
          sendDesktopNotification("Execution error", "error");
          refreshDerived();
          resetTrajectoryBases();
          return;
        }
      } catch (e) {
        debugWarn(
          "message_stream",
          "Unhandled conversation error: %s",
          e instanceof Error ? (e.stack ?? e.message) : String(e),
        );

        if (abortControllerRef.current !== turnAbortController) {
          return;
        }

        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          isUserAbortError(e) ? "user_interrupt" : "stream_error",
        );

        if (EAGER_CANCEL && isUserAbortError(e)) {
          const partials = (e as { partialResults?: ApprovalResult[] })
            .partialResults;
          const overlaid = partials
            ? overlayPartialResults(queuedApprovalResultsRef.current, partials)
            : [];
          if (overlaid.length > 0) {
            queueApprovalResults(overlaid);
          }
          setStreaming(false);
          refreshDerived();
          return;
        }

        const errorDetails = formatErrorDetails(e, agentIdRef.current);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          errorMessage: e instanceof Error ? e.message : String(e),
          context: "message_stream",
          runId: currentRunId,
        });
        appendError(ERROR_FEEDBACK_HINT, true);

        if (lastDequeuedMessageRef.current) {
          setRestoredInput(lastDequeuedMessageRef.current);
          lastDequeuedMessageRef.current = null;
        }
        tuiQueueRef.current?.clear("error");

        setStreaming(false);
        sendDesktopNotification("Processing error", "error");
        refreshDerived();
        resetTrajectoryBases();
      } finally {
        if (!preserveTranscriptStartForApproval) {
          pendingTranscriptStartLineIndexRef.current = null;
        }

        finishTuiTurn({
          isStale: myGeneration !== conversationGenerationRef.current,
          turnAbortController,
          abortControllerRef,
          processingConversationRef,
          userCancelledRef,
          setInterruptRequested,
          queueLength: () => tuiQueueRef.current?.length ?? 0,
          bumpDequeueEpoch: () => setDequeueEpoch((e: number) => e + 1),
        });
      }
    },
    [
      appendError,
      refreshDerived,
      refreshDerivedThrottled,
      setStreaming,
      setConversationSummary,
      currentModelId,
      updateStreamingOutput,
      needsEagerApprovalCheck,
      queueApprovalResults,
      consumeQueuedMessages,
      appendTaskNotificationEvents,
      clearApprovalToolContext,
      openTrajectorySegment,
      syncTrajectoryTokenBase,
      syncTrajectoryElapsedBase,
      closeTrajectorySegment,
      resetTrajectoryBases,
      setUiPermissionMode,
      prepareScopedToolExecutionContext,
      maybeStreamSyntheticNoModelResponse,
      modAdapter,
    ],
  );

  return processConversation;
}
