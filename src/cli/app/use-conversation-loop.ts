// src/cli/app/useConversationLoop.ts

import { randomUUID } from "node:crypto";
import { APIError, APIUserAbortError } from "@letta-ai/letta-client/core/error";
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
import { executeAutoAllowedTools } from "@/agent/approval-execution";
import {
  extractConflictDetail,
  fetchRunErrorDetail,
  getPreStreamErrorAction,
  getRetryDelayMs,
  isApprovalPendingError,
  isEmptyResponseRetryable,
  isInvalidToolCallIdsError,
  isQuotaLimitErrorDetail,
  parseRetryAfterHeaderMs,
  rebuildInputWithFreshDenials,
  refreshInputOtidsForNewRequest,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
  shouldAttemptApprovalRecovery,
} from "@/agent/approval-recovery";
import { getAvailableModelHandles } from "@/agent/available-models";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { getStreamToolContextId, sendMessageStream } from "@/agent/message";
import { getModelInfo, getModelInfoForLlmConfig } from "@/agent/model";
import { INTERRUPT_RECOVERY_ALERT } from "@/agent/prompt-assets";
import type { SessionStats } from "@/agent/stats";
import {
  clearCompletedSubagents,
  hasActiveSubagents,
} from "@/agent/subagent-state";
import { type ConversationMessageStreamBody, getBackend } from "@/backend";
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
} from "@/cli/helpers/error-formatter";
import { parsePatchOperations } from "@/cli/helpers/format-args-display";
import {
  buildLocalNoModelResponse,
  splitSyntheticAssistantResponse,
} from "@/cli/helpers/local-no-model-response";
import type { ExecutionPhase } from "@/cli/helpers/phase-visuals";
import {
  buildQueuedContentParts,
  buildQueuedUserText,
  getQueuedNotificationSummaries,
} from "@/cli/helpers/queued-message-parts";
import { appendTranscriptDeltaJsonl } from "@/cli/helpers/reflection-transcript";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";
import {
  type ApprovalRequest,
  type DrainResult,
  drainStream,
  drainStreamWithResume,
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
import { alwaysRequiresUserInput } from "@/cli/helpers/tool-name-mapping.js";
import type { LocalModAdapter } from "@/cli/mods/use-local-mod-adapter";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { runStopHooks } from "@/hooks";
import { getTurnStartCancel } from "@/mods/turn-start-cancel";
import type { ApprovalContext } from "@/permissions/analyzer";
import { formatPermissionDenial } from "@/permissions/format-denial";
import type { PermissionMode } from "@/permissions/mode";
import { permissionMode } from "@/permissions/mode";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
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
  PROVIDER_FALLBACK_MAP,
  TEMP_QUOTA_OVERRIDE_MODEL,
} from "./constants";
import { extractErrorMeta } from "./errors";
import { appendOptimisticUserLine, createClientOtid, uid } from "./ids";
import {
  getErrorHintForStopReason,
  getPreferredAgentModelHandle,
} from "./model-config";
import { sendDesktopNotification } from "./notifications";
import { isRetriableError } from "./retry";
import { stripSystemReminders } from "./system-reminders";
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
  providerFallbackAttemptedRef: MutableRefObject<boolean>;
  queueApprovalResults: QueueApprovalResults;
  queueSnapshotRef: MutableRefObject<QueuedMessage[]>;
  quotaAutoSwapAttemptedRef: MutableRefObject<boolean>;
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
    providerFallbackAttemptedRef,
    queueApprovalResults,
    queueSnapshotRef,
    quotaAutoSwapAttemptedRef,
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
    setTempModelOverride,
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

  // Core streaming function - iterative loop that processes conversation turns
  // biome-ignore lint/correctness/useExhaustiveDependencies: blanket suppression — this callback has ~16 omitted deps (refs, stable functions, etc.). Refs are safe (read .current dynamically), but the blanket ignore also hides any genuinely missing reactive deps. If stale-closure bugs appear in processConversation, audit the dep array here first.
  const processConversation = useCallback(
    async (
      initialInput: Array<MessageCreate | ApprovalCreate>,
      options?: {
        allowReentry?: boolean;
        submissionGeneration?: number;
        transcriptStartLineIndex?: number | null;
        allowResponseStateReuse?: boolean;
      },
    ): Promise<void> => {
      // Transient pre-stream retries can yield for seconds.
      // Pin the user's permission mode for the duration of the submission so
      // auto-approvals (YOLO / unrestricted) don't regress after a retry.
      const pinnedPermissionMode = uiPermissionModeRef.current;
      const restorePinnedPermissionMode = () => {
        if (permissionMode.getMode() !== pinnedPermissionMode) {
          permissionMode.setMode(pinnedPermissionMode);
        }
        if (uiPermissionModeRef.current !== pinnedPermissionMode) {
          setUiPermissionMode(pinnedPermissionMode);
        }
      };

      // Reset per-run approval tracking used by streaming UI.
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
            } catch {
              // Args still incomplete.
            }
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
      // Copy so we can safely mutate for retry recovery flows
      const inputList = Array.isArray(initialInput) ? initialInput : [];
      let currentInput = [...inputList];
      const allowReentry = options?.allowReentry ?? false;

      // Use provided generation (from onSubmit) or capture current
      // This allows detecting if ESC was pressed during async work before this function was called
      const myGeneration =
        options?.submissionGeneration ?? conversationGenerationRef.current;

      // Check if we're already stale (ESC was pressed while we were queued in onSubmit).
      // This can happen if ESC was pressed during async work before processConversation was called.
      // We check early to avoid setting state (streaming, etc.) for stale conversations.
      if (myGeneration !== conversationGenerationRef.current) {
        return;
      }

      // Guard against concurrent processConversation calls
      // This can happen if user submits two messages in quick succession
      // Uses dedicated ref (not streamingRef) since streaming may be set early for UI responsiveness
      if (processingConversationRef.current > 0 && !allowReentry) {
        return;
      }
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
          // Mod turn_start handlers should not block sending the turn.
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

      // Reset retry counters for new conversation turns (fresh budget per user message)
      if (!allowReentry) {
        llmApiErrorRetriesRef.current = 0;
        emptyResponseRetriesRef.current = 0;
        conversationBusyRetriesRef.current = 0;
        quotaAutoSwapAttemptedRef.current = false;
        providerFallbackAttemptedRef.current = false;
      }

      // Track last run ID for error reporting (accessible in catch block)
      let currentRunId: string | undefined;
      let preserveTranscriptStartForApproval = false;

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

        // Check if user hit escape before we started
        if (userCancelledRef.current) {
          userCancelledRef.current = false; // Reset for next time
          return;
        }

        // Double-check we haven't become stale between entry and try block
        if (myGeneration !== conversationGenerationRef.current) {
          return;
        }

        setStreaming(true);
        openTrajectorySegment();
        setNetworkPhase("upload");
        setExecutionPhase("requesting");
        abortControllerRef.current = new AbortController();

        if (
          await maybeStreamSyntheticNoModelResponse(
            currentInput,
            allowReentry,
            hasApprovalInput,
          )
        ) {
          return;
        }

        // Recover interrupted message only after explicit user interrupt:
        // if cache contains ONLY user messages, prepend them.
        // Note: type="message" is a local discriminator (not in SDK types) to distinguish from approvals
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
            // Refresh OTIDs — this is a new request, not a retry of the interrupted one
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
          // Cache old + new for chained recovery
          lastSentInputRef.current = [
            ...lastSentInputRef.current,
            ...originalInput,
          ];
        } else {
          pendingInterruptRecoveryConversationIdRef.current = null;
          lastSentInputRef.current = originalInput;
        }

        // Clear any stale pending tool calls from previous turns
        // If we're sending a new message, old pending state is no longer relevant
        // Pass false to avoid setting interrupted=true, which causes race conditions
        // with concurrent processConversation calls reading the flag
        // IMPORTANT: Skip this when allowReentry=true (continuing after tool execution)
        // because server-side tools (like memory) may still be pending and their results
        // will arrive in this stream. Cancelling them prematurely shows "Cancelled" in UI.
        if (!allowReentry) {
          markIncompleteToolsAsCancelled(
            buffersRef.current,
            false,
            "internal_cancel",
          );
        }
        // Reset interrupted flag since we're starting a fresh stream
        buffersRef.current.interrupted = false;

        // Clear completed subagents only on true new turns.
        if (
          shouldClearCompletedSubagentsOnTurnStart(
            allowReentry,
            hasActiveSubagents(),
          )
        ) {
          clearCompletedSubagents();
        }

        let highestSeqIdSeen: number | null = null;

        while (true) {
          // Capture the signal BEFORE any async operations
          // This prevents a race where handleInterrupt nulls the ref during await
          const signal = abortControllerRef.current?.signal;

          // Check if cancelled before starting new stream
          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            // Only set streaming=false if this is the current generation.
            // If stale, a newer processConversation might be running and we shouldn't affect its UI.
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          // Inject queued skill content as user message parts (LET-7353)
          // This centralizes skill content injection so all approval-send paths
          // automatically get skill SKILL.md content alongside tool results.
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

          // Stream one turn - use ref to always get the latest conversationId
          // Wrap in try-catch to handle pre-stream desync errors (when sendMessageStream
          // throws before streaming begins, e.g., retry after LLM error when backend
          // already cleared the approval)
          let stream: Awaited<ReturnType<typeof sendMessageStream>> | null =
            null;
          let turnToolContextId: string | null = null;
          let preStreamResumeResult: DrainResult | null = null;
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

            // Extract error detail using shared helper (handles nested/direct/message shapes)
            const errorDetail = extractConflictDetail(preStreamError);

            // Route through shared pre-stream conflict classifier (parity with headless.ts)
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

            // Resolve stale approval conflict: fetch real pending approvals, auto-deny, retry.
            // Shares llmApiErrorRetriesRef budget with LLM transient-error retries (max 3 per turn).
            // Resets on each processConversation entry and on success.
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
                // Fetch failed — strip stale payload and retry plain message
                currentInput = rebuildInputWithFreshDenials(
                  currentInput,
                  [],
                  "",
                );
              }
              buffersRef.current.interrupted = false;
              continue;
            }

            // Check for 409 "conversation busy" error - retry with exponential backoff
            if (preStreamAction === "retry_conversation_busy") {
              conversationBusyRetriesRef.current += 1;
              const retryDelayMs = getRetryDelayMs({
                category: "conversation_busy",
                attempt: conversationBusyRetriesRef.current,
              });

              // Log the conversation-busy error
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

              // Attempt to resume the in-flight run via the conversation stream endpoint.
              // Server resolves: (1) otid lookup, (2) active run fallback.
              try {
                const backend = getBackend();
                const messageOtid = currentInput
                  .map((item) => (item as Record<string, unknown>).otid)
                  .find((v): v is string => typeof v === "string");
                debugLog(
                  "stream",
                  "Conversation busy: resuming via stream endpoint (otid=%s)",
                  messageOtid ?? "none",
                );

                if (signal?.aborted || userCancelledRef.current) {
                  const isStaleAtAbort =
                    myGeneration !== conversationGenerationRef.current;
                  if (!isStaleAtAbort) {
                    setStreaming(false);
                  }
                  return;
                }

                const conversationId = conversationIdRef.current ?? "default";
                const resumeStream = await backend.streamConversationMessages(
                  conversationId,
                  // Cast needed until SDK MessageStreamParams includes otid field
                  {
                    agent_id:
                      conversationId === "default"
                        ? (agentIdRef.current ?? undefined)
                        : undefined,
                    otid: messageOtid ?? undefined,
                    starting_after: 0,
                    batch_size: 1000,
                  } as unknown as ConversationMessageStreamBody,
                );

                // Only reset buffer state after confirming stream is available
                buffersRef.current.interrupted = false;
                buffersRef.current.commitGeneration =
                  (buffersRef.current.commitGeneration || 0) + 1;

                preStreamResumeResult = await drainStream(
                  resumeStream,
                  buffersRef.current,
                  refreshDerivedThrottled,
                  signal,
                  undefined, // no handleFirstMessage on resume
                  makeExecutionPhaseHook(setExecutionPhase),
                  contextTrackerRef.current,
                  highestSeqIdSeen,
                );
                debugLog(
                  "stream",
                  "Pre-stream resume succeeded (stopReason=%s)",
                  preStreamResumeResult.stopReason,
                );
                // Fall through — preStreamResumeResult will short-circuit drainStreamWithResume
              } catch (resumeError) {
                if (signal?.aborted || userCancelledRef.current) {
                  const isStaleAtAbort =
                    myGeneration !== conversationGenerationRef.current;
                  if (!isStaleAtAbort) {
                    setStreaming(false);
                  }
                  return;
                }

                debugLog(
                  "stream",
                  "Pre-stream resume failed, falling back to wait/retry: %s",
                  resumeError instanceof Error
                    ? resumeError.message
                    : String(resumeError),
                );
                // Fall through to existing wait/retry behavior
              }

              // If resume succeeded, skip the wait/retry loop
              if (!preStreamResumeResult) {
                // Show status message
                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: ["Conversation is busy, waiting and retrying…"],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();

                // Wait with abort checking (same pattern as LLM API error retry)
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

                // Remove status message
                buffersRef.current.byId.delete(statusId);
                buffersRef.current.order = buffersRef.current.order.filter(
                  (id: string) => id !== statusId,
                );
                refreshDerived();

                if (!cancelled) {
                  // Reset interrupted flag so retry stream chunks are processed
                  buffersRef.current.interrupted = false;
                  restorePinnedPermissionMode();
                  continue;
                }
              }
              // User pressed ESC - fall through to error handling
            }

            // Retry pre-stream transient errors (429/5xx/network) with shared LLM retry budget
            if (preStreamAction === "retry_transient") {
              llmApiErrorRetriesRef.current += 1;
              const attempt = llmApiErrorRetriesRef.current;

              // Provider fallback: after 1 retry against Anthropic, switch to Bedrock
              if (
                attempt >= 2 &&
                !providerFallbackAttemptedRef.current &&
                currentModelId
              ) {
                const fallbackId = PROVIDER_FALLBACK_MAP[currentModelId];
                const fallbackHandle = fallbackId
                  ? getModelInfo(fallbackId)?.handle
                  : undefined;
                if (fallbackHandle) {
                  providerFallbackAttemptedRef.current = true;
                  setTempModelOverride(fallbackHandle);

                  const statusId = uid("status");
                  buffersRef.current.byId.set(statusId, {
                    kind: "status",
                    id: statusId,
                    lines: ["Anthropic API error; falling back to Bedrock..."],
                  });
                  buffersRef.current.order.push(statusId);
                  refreshDerived();

                  buffersRef.current.interrupted = false;
                  conversationBusyRetriesRef.current = 0;
                  restorePinnedPermissionMode();
                  continue;
                }
              }

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

              // Log the error that triggered the retry
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
              // User pressed ESC - fall through to error handling
            }

            // Reset conversation busy retry counter on non-busy error
            conversationBusyRetriesRef.current = 0;

            // Check if this is a pre-stream approval desync error
            const hasApprovalInPayload = currentInput.some(
              (item) => item?.type === "approval",
            );

            if (hasApprovalInPayload) {
              // "Invalid tool call IDs" means server HAS pending approvals but with different IDs.
              // We need to fetch the actual pending approvals and show them to the user.
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
                    // Preserve user message from current input (if any)
                    // Filter out system reminders to avoid re-injecting them
                    const userMessage = currentInput.find(
                      (item) => item?.type === "message",
                    );
                    if (userMessage && "content" in userMessage) {
                      const content = userMessage.content;
                      let textToRestore = "";
                      if (typeof content === "string") {
                        textToRestore = stripSystemReminders(content);
                      } else if (Array.isArray(content)) {
                        // Extract text parts, filtering out system reminders
                        textToRestore = content
                          .filter(
                            (c): c is { type: "text"; text: string } =>
                              typeof c === "object" &&
                              c !== null &&
                              "type" in c &&
                              c.type === "text" &&
                              "text" in c &&
                              typeof c.text === "string" &&
                              !c.text.includes(SYSTEM_REMINDER_OPEN) &&
                              !c.text.includes(SYSTEM_ALERT_OPEN),
                          )
                          .map((c) => c.text)
                          .join("\n");
                      }
                      if (textToRestore.trim()) {
                        setRestoredInput(textToRestore);
                      }
                    }

                    // Clear all stale approval state before setting new approvals
                    setApprovalResults([]);
                    setAutoHandledResults([]);
                    setAutoDeniedApprovals([]);
                    setApprovalContexts([]);
                    queueApprovalResults(null);

                    // Set up approval UI with fetched approvals
                    setPendingApprovals(serverApprovals);

                    // Analyze approval contexts (same logic as /resume)
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
                    } catch {
                      // If analysis fails, contexts remain empty (will show basic options)
                    }

                    // Stop streaming and exit - user needs to approve/deny
                    // (finally block will decrement processingConversationRef)
                    setStreaming(false);
                    sendDesktopNotification("Approval needed");
                    return;
                  }
                  // No approvals found - fall through to error handling below
                } catch {
                  // Fetch failed - fall through to error handling below
                }
              }
            }

            // Not a recoverable desync - re-throw to outer catch
            throw preStreamError;
          }

          // Check again after network call - user may have pressed Escape during sendMessageStream
          if (signal?.aborted) {
            const isStaleAtAbort =
              myGeneration !== conversationGenerationRef.current;
            // Only set streaming=false if this is the current generation.
            // If stale, a newer processConversation might be running and we shouldn't affect its UI.
            if (!isStaleAtAbort) {
              setStreaming(false);
            }
            return;
          }

          // Define callback to sync agent state on first message chunk
          // This ensures the UI shows the correct model as early as possible
          const syncAgentState = async () => {
            try {
              // Reuse the agent fetched by prepareToolExecutionContextForScope
              // (avoids a redundant agents.retrieve per turn).
              const agent =
                prefetchedAgent ??
                (await getBackend().retrieveAgent(agentIdRef.current));

              // Keep model UI in sync with the agent configuration.
              // Note: many tiers share the same handle (e.g. gpt-5.2-none/high), so we
              // must also treat reasoning settings as model-affecting.
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
                  // Model has changed at the agent level - update local state.
                  setLlmConfig(agent.llm_config);

                  // Derive model ID from the configured model handle for ModelSelector.
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
                    // Model not in models.json (e.g., BYOK model) - use handle as ID
                    setCurrentModelId(agentModelHandle || null);
                  }
                  setCurrentModelHandle(agentModelHandle || null);
                }

                // Always keep base agent state fresh.
                setAgentState(agent);
                setAgentDescription(agent.description ?? null);
                const lastRunCompletion = (
                  agent as { last_run_completion?: string }
                ).last_run_completion;
                setAgentLastRunAt(lastRunCompletion ?? null);
              }
            } catch (error) {
              // Silently fail - don't interrupt the conversation flow
              debugLog("sync-agent", "Failed to sync agent state: %O", error);
            }
          };

          const isAutoApprovalMode = pinnedPermissionMode === "unrestricted";
          const isUserInitiated = currentInput.some(
            (item) => item.type === "message" && item.role === "user",
          );
          const handleFirstMessage = () => {
            setNetworkPhase("download");
            // Only sync agent state on user messages or when manual approval
            // mode is active (user may have changed model while reviewing).
            // In bypass mode, tool-result continuations happen instantly —
            // no time for the agent to have changed.
            if (isUserInitiated || !isAutoApprovalMode) {
              void syncAgentState();
            }
          };

          const runTokenStart = buffersRef.current.tokenCount;
          trajectoryRunTokenStartRef.current = runTokenStart;
          sessionStatsRef.current.startTrajectory();

          // Only bump turn counter for actual user messages, not approval continuations.
          // This ensures all LLM steps within one user "turn" are counted as one.
          const hasUserMessage = currentInput.some(
            (item) => item.type === "message",
          );
          if (hasUserMessage) {
            contextTrackerRef.current.currentTurnId++;
          }

          const drainResult = preStreamResumeResult
            ? preStreamResumeResult
            : (() => {
                if (!stream) {
                  throw new Error(
                    "Expected stream when pre-stream resume did not succeed",
                  );
                }
                return drainStreamWithResume(
                  stream,
                  buffersRef.current,
                  refreshDerivedThrottled,
                  signal, // Use captured signal, not ref (which may be nulled by handleInterrupt)
                  handleFirstMessage,
                  makeExecutionPhaseHook(setExecutionPhase),
                  contextTrackerRef.current,
                  highestSeqIdSeen,
                );
              })();

          const {
            stopReason,
            approval,
            approvals,
            apiDurationMs,
            lastRunId,
            lastSeqId,
            fallbackError,
          } = await drainResult;

          if (lastSeqId != null) {
            highestSeqIdSeen = Math.max(highestSeqIdSeen ?? 0, lastSeqId);
          }

          // Update currentRunId for error reporting in catch block
          currentRunId = lastRunId ?? undefined;
          // Expose to statusline
          if (lastRunId) lastRunIdRef.current = lastRunId;

          // Track API duration and trajectory deltas
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

          // Check if this conversation became stale while the stream was running.
          // If stale, a newer processConversation is running and we shouldn't modify UI state.
          const isStaleAfterDrain =
            myGeneration !== conversationGenerationRef.current;

          // If this conversation is stale, exit without modifying UI state.
          // A newer conversation is running and should control the UI.
          if (isStaleAfterDrain) {
            return;
          }

          // Immediate refresh after stream completes to show final state unless
          // the user already cancelled (handleInterrupt rendered the UI).
          if (!wasInterrupted) {
            refreshDerived();
          }

          // If the turn was interrupted client-side but the backend had already emitted
          // requires_approval, treat it as a cancel. This avoids re-entering approval flow
          // and keeps queue-cancel flags consistent with the normal cancel branch below.
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

          // Record the final stop reason so the dequeue gate can check it.
          lastStopReasonRef.current = stopReasonToHandle;

          // Case 1: Turn ended normally
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
            llmApiErrorRetriesRef.current = 0; // Reset retry counter on success
            emptyResponseRetriesRef.current = 0;
            conversationBusyRetriesRef.current = 0;
            providerFallbackAttemptedRef.current = false;
            lastDequeuedMessageRef.current = null; // Clear - message was processed successfully
            lastSentInputRef.current = null; // Clear - no recovery needed
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

            // Evaluate reflection triggers now that the turn's transcript
            // delta is on disk, so step counts include this turn.
            await maybeRunPostTurnReflection();

            // Get last assistant message, user message, and reasoning for Stop hook
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
            buffersRef.current.lastReasoning = undefined; // Clear after use

            // Run Stop hooks - if blocked/errored, continue the conversation with feedback
            const stopHookResult = await runStopHooks(
              stopReasonToHandle,
              buffersRef.current.order.length,
              bufferedLines.filter((item) => item.kind === "tool_call").length,
              undefined, // workingDirectory (uses default)
              precedingReasoning,
              assistantMessage,
              userMessage,
            );

            // If hook blocked (exit 2), inject stderr feedback and continue conversation
            if (stopHookResult.blocked) {
              const stderrOutput = stopHookResult.results
                .map((r) => r.stderr)
                .filter(Boolean)
                .join("\n");
              const feedback = stderrOutput || "Stop hook blocked";
              const hookMessage = `<stop-hook>\n${feedback}\n</stop-hook>`;

              // Add status to transcript so user sees what's happening
              const statusId = uid("status");
              buffersRef.current.byId.set(statusId, {
                kind: "status",
                id: statusId,
                lines: ["Stop hook blocked, continuing conversation."],
              });
              buffersRef.current.order.push(statusId);
              refreshDerived();

              // Continue conversation with the hook feedback
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

            // Emit turn_end mod event. A mod may return { continue: "..." } to
            // append a follow-up user message and start another turn.
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
              // turn_end handlers are best-effort; never block turn completion.
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

            // Disable eager approval check after first successful message (LET-7101)
            // Any new approvals from here on are from our own turn, not orphaned
            if (needsEagerApprovalCheck) {
              setNeedsEagerApprovalCheck(false);
            }

            // Derive an auto title client-side once the first assistant turn completes.
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
                    // Silently ignore - not critical.
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

            // Send desktop notification when turn completes
            // and we're not about to auto-send another queued message
            if (!waitingForQueueCancelRef.current) {
              sendDesktopNotification("Turn completed, awaiting your input");
            }

            // Check if we were waiting for cancel but stream finished naturally
            if (waitingForQueueCancelRef.current) {
              // Queue-cancel completed - let dequeue effect handle the messages
              // We don't call onSubmit here because isAgentBusy() would return true
              // (abortControllerRef is still set until finally block), causing re-queue
              debugLog(
                "queue",
                "Queue-cancel completed (end_turn): messages will be processed by dequeue effect",
              );
              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              // Reset flags - dequeue effect will fire when streaming=false commits
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            }

            return;
          }

          // Case 1.5: Stream was cancelled by user
          if (stopReasonToHandle === "cancelled") {
            clearApprovalToolContext();
            pendingTranscriptStartLineIndexRef.current = null;
            setStreaming(false);
            closeTrajectorySegment();
            syncTrajectoryElapsedBase();

            // Check if this cancel was triggered by queue threshold
            if (waitingForQueueCancelRef.current) {
              // Queue-cancel completed - let dequeue effect handle the messages
              // We don't call onSubmit here because isAgentBusy() would return true
              // (abortControllerRef is still set until finally block), causing re-queue
              debugLog(
                "queue",
                "Queue-cancel completed (cancelled): messages will be processed by dequeue effect",
              );
              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              // Reset flags - dequeue effect will fire when streaming=false commits
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
            } else {
              // Regular user cancellation - show error
              if (!EAGER_CANCEL) {
                appendError(INTERRUPT_MESSAGE, true);
              }
            }

            return;
          }

          // Case 2: Requires approval
          if (stopReasonToHandle === "requires_approval") {
            clearApprovalToolContext();
            preserveTranscriptStartForApproval = true;
            approvalToolContextIdRef.current = turnToolContextId;
            // Clear stale state immediately to prevent ID mismatch bugs
            setAutoHandledResults([]);
            setAutoDeniedApprovals([]);
            lastSentInputRef.current = null; // Clear - message was received by server
            pendingInterruptRecoveryConversationIdRef.current = null;

            // Use new approvals array, fallback to legacy approval for backward compat
            const approvalsToProcess = approvalsFromStream;

            if (approvalsToProcess.length === 0) {
              clearApprovalToolContext();
              appendError(
                `Unexpected empty approvals with stop reason: ${stopReason}`,
              );
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              return;
            }

            // If in quietCancel mode (user queued messages), auto-reject all approvals
            // and send denials + queued messages together
            if (waitingForQueueCancelRef.current) {
              clearApprovalToolContext();
              // Create denial results for all approvals
              const denialResults = approvalsToProcess.map((approvalItem) => ({
                type: "approval" as const,
                tool_call_id: approvalItem.toolCallId,
                approve: false,
                reason: "User cancelled - new message queued",
              }));

              // Update buffers to show tools as cancelled
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

              // Queue denial results - dequeue effect will pick them up via onSubmit
              queueApprovalResults(denialResults);

              debugLog(
                "queue",
                `Queue-cancel completed (requires_approval): ${denialResults.length} denial(s) queued, messages will be processed by dequeue effect`,
              );

              if (restoreQueueOnCancelRef.current) {
                setRestoreQueueOnCancel(false);
              }

              // Reset flags - dequeue effect will fire when streaming=false commits
              waitingForQueueCancelRef.current = false;
              queueSnapshotRef.current = [];
              setStreaming(false);
              closeTrajectorySegment();
              syncTrajectoryElapsedBase();
              return;
            }

            // Check if user cancelled before starting permission checks
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

            // Check permissions for all approvals (including fancy UI tools)
            // Ensure the singleton permission mode matches what the UI shows.
            // This prevents rare races where the footer shows YOLO but approvals still
            // get classified using the default mode.
            const desiredMode = uiPermissionModeRef.current;
            if (permissionMode.getMode() !== desiredMode) {
              permissionMode.setMode(desiredMode);
            }

            const { needsUserInput, autoAllowed, autoDenied } =
              await classifyApprovals(approvalsToProcess, {
                getContext: analyzeToolApproval,
                alwaysRequiresUserInput,
                requireArgsForAutoApprove: true,
                missingNameReason:
                  "Tool call incomplete - missing name or arguments",
                toolContextId: approvalToolContextIdRef.current,
              });

            // Precompute diffs for file edit tools before execution (both auto-allowed and needs-user-input)
            // This is needed for inline approval UI to show diffs, and for post-approval rendering
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
                    // Check if it's a multi-edit (has edits array) or single edit
                    if (args.edits && Array.isArray(args.edits)) {
                      const result = computeAdvancedDiff({
                        kind: "multi_edit",
                        filePath,
                        edits: args.edits as Array<{
                          old_string: string;
                          new_string: string;
                          replace_all?: boolean;
                        }>,
                      });
                      if (result.mode === "advanced") {
                        precomputedDiffsRef.current.set(toolCallId, result);
                      }
                    } else {
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
                  }
                } else if (isPatchTool(toolName) && args.input) {
                  // Patch tools - parse hunks directly (patches ARE diffs)
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
                    // Delete operations don't need diffs
                  }
                }
              } catch {
                // Ignore errors in diff computation for auto-allowed tools
              }
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
            let autoDeniedResults: Array<{
              approval: ApprovalRequest;
              reason: string;
            }> = [];

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
                // Set phase to "running" for auto-allowed tools
                setToolCallsRunning(buffersRef.current, autoAllowedToolCallIds);
                refreshDerived();
              }

              // Execute auto-allowed tools (sequential for writes, parallel for reads)
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

              // Create denial results for auto-denied tools and update buffers
              autoDeniedResults = autoDenied.map((ac) => {
                const reason = formatPermissionDenial(ac.permission);

                // Update buffers with tool rejection for UI
                onChunk(buffersRef.current, {
                  message_type: "tool_return_message",
                  id: "dummy",
                  date: new Date().toISOString(),
                  tool_call_id: ac.approval.toolCallId,
                  tool_return: `Error: request to call tool denied. User reason: ${reason}`,
                  status: "error",
                  stdout: null,
                  stderr: null,
                });

                return {
                  approval: ac.approval,
                  reason,
                };
              });

              const allResults = [
                ...autoAllowedResults.map((ar) => ({
                  type: "tool" as const,
                  tool_call_id: ar.toolCallId,
                  tool_return: ar.result.toolReturn,
                  status: ar.result.status,
                  stdout: ar.result.stdout,
                  stderr: ar.result.stderr,
                })),
                ...autoDeniedResults.map((ad) => ({
                  type: "approval" as const,
                  tool_call_id: ad.approval.toolCallId,
                  approve: false,
                  reason: ad.reason,
                })),
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

              // If all are auto-handled, continue immediately without showing dialog
              if (needsUserInput.length === 0) {
                // Check if user cancelled before continuing
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

                // Append queued messages if any (from 15s append mode).
                // In defer mode, skip mid-run bundling — let the dequeue gate
                // handle dispatch after the agent is fully done (end_turn).
                const queuedItemsToAppend =
                  queueModeRef.current === "immediate"
                    ? consumeQueuedMessages()
                    : null;
                const queuedNotifications = queuedItemsToAppend
                  ? getQueuedNotificationSummaries(queuedItemsToAppend)
                  : [];
                const hadNotifications =
                  appendTaskNotificationEvents(queuedNotifications);
                const queuedUserText = queuedItemsToAppend
                  ? buildQueuedUserText(queuedItemsToAppend)
                  : "";

                const queuedUserOtid = createClientOtid();
                appendOptimisticUserLine(
                  buffersRef.current,
                  queuedUserText,
                  queuedUserOtid,
                );

                if (queuedItemsToAppend && queuedItemsToAppend.length > 0) {
                  const queuedContentParts =
                    buildQueuedContentParts(queuedItemsToAppend);
                  setThinkingMessage(getRandomThinkingVerb());
                  refreshDerived();
                  toolResultsInFlightRef.current = true;
                  await processConversation(
                    [
                      {
                        type: "approval",
                        approvals: allResults,
                        otid: createClientOtid(),
                      },
                      {
                        type: "message",
                        role: "user",
                        content: queuedContentParts,
                        otid: queuedUserOtid,
                      },
                    ],
                    { allowReentry: true },
                  );
                  toolResultsInFlightRef.current = false;
                  return;
                }
                if (hadNotifications || queuedUserText.length > 0) {
                  refreshDerived();
                }

                // Cancel mode - queue results and let dequeue effect handle
                if (waitingForQueueCancelRef.current) {
                  // Queue results - dequeue effect will pick them up via onSubmit
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

                  // Reset flags - dequeue effect will fire when streaming=false commits
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

              // Check again if user queued messages during auto-allowed tool execution
              if (waitingForQueueCancelRef.current) {
                // Create denial results for tools that need user input
                const denialResults = needsUserInput.map((ac) => ({
                  type: "approval" as const,
                  tool_call_id: ac.approval.toolCallId,
                  approve: false,
                  reason: "User cancelled - new message queued",
                }));

                // Update buffers to show tools as cancelled
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

                // Combine with auto-handled results and queue for sending
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

                // Reset flags - dequeue effect will fire when streaming=false commits
                waitingForQueueCancelRef.current = false;
                queueSnapshotRef.current = [];
                setStreaming(false);
                closeTrajectorySegment();
                syncTrajectoryElapsedBase();
                return;
              }
            } finally {
              if (shouldTrackAutoAllowed) {
                setIsExecutingTool(false);
                toolAbortControllerRef.current = null;
                executingToolCallIdsRef.current = [];
                autoAllowedExecutionRef.current = null;
                toolResultsInFlightRef.current = false;
              }
            }

            // Check if user cancelled before showing dialog
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

            // Show approval dialog for tools that need user input
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
            // Notify user that approval is needed
            sendDesktopNotification("Approval needed");
            return;
          }

          // Unexpected stop reason (error, llm_api_error, etc.)
          // Cache desync detection and last failure for consistent handling
          // Check if payload contains approvals (could be approval-only or mixed with user message)
          const hasApprovalInPayload = currentInput.some(
            (item) => item?.type === "approval",
          );

          // Capture the most recent error text in this turn (if any)
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

          // Check for "Invalid tool call IDs" error - server HAS pending approvals but with different IDs.
          // Fetch the actual pending approvals and show them to the user.
          const detailFromRun = await fetchRunErrorDetail(lastRunId);
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
                // Preserve user message from current input (if any)
                // Filter out system reminders to avoid re-injecting them
                const userMessage = currentInput.find(
                  (item) => item?.type === "message",
                );
                if (userMessage && "content" in userMessage) {
                  const content = userMessage.content;
                  let textToRestore = "";
                  if (typeof content === "string") {
                    textToRestore = stripSystemReminders(content);
                  } else if (Array.isArray(content)) {
                    // Extract text parts, filtering out system reminders
                    textToRestore = content
                      .filter(
                        (c): c is { type: "text"; text: string } =>
                          typeof c === "object" &&
                          c !== null &&
                          "type" in c &&
                          c.type === "text" &&
                          "text" in c &&
                          typeof c.text === "string" &&
                          !c.text.includes(SYSTEM_REMINDER_OPEN) &&
                          !c.text.includes(SYSTEM_ALERT_OPEN),
                      )
                      .map((c) => c.text)
                      .join("\n");
                  }
                  if (textToRestore.trim()) {
                    setRestoredInput(textToRestore);
                  }
                }

                // Clear all stale approval state before setting new approvals
                setApprovalResults([]);
                setAutoHandledResults([]);
                setAutoDeniedApprovals([]);
                setApprovalContexts([]);
                queueApprovalResults(null);

                // Set up approval UI with fetched approvals
                setPendingApprovals(serverApprovals);

                // Analyze approval contexts
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
                } catch {
                  // If analysis fails, contexts remain empty (will show basic options)
                }

                // Stop streaming and exit - user needs to approve/deny
                // (finally block will decrement processingConversationRef)
                setStreaming(false);
                sendDesktopNotification("Approval needed");
                return;
              }
              // No approvals found - fall through to error handling below
            } catch {
              // Fetch failed - fall through to error handling below
            }
          }

          // Check for approval pending error (sent user message while approval waiting).
          // This is the lazy recovery path: fetch real pending approvals, auto-deny, retry.
          // Works regardless of hasApprovalInPayload — stale queued approvals from an
          // interrupt may have been rejected by the backend.
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
              // Fetch pending approvals and auto-deny them
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
              // Fetch failed — strip stale payload and retry plain message
              currentInput = rebuildInputWithFreshDenials(currentInput, [], "");
            }

            // Reset interrupted flag so retry stream chunks are processed
            buffersRef.current.interrupted = false;
            continue;
          }

          // Quota-limit fallback: hosted Letta API can recover by switching to
          // Auto. Local/embedded mode has no hosted Auto router, so surface the
          // provider quota error and let the user choose/connect a local model.
          const autoSwapOnQuotaLimitEnabled =
            settingsManager.getSetting("autoSwapOnQuotaLimit") !== false;
          const supportsHostedAutoQuotaFallback =
            !getBackend().capabilities.localModelCatalog;
          const isQuotaLimit = isQuotaLimitErrorDetail(
            detailFromRun ?? fallbackError,
          );
          const alreadyOnTempAuto =
            tempModelOverrideRef.current === TEMP_QUOTA_OVERRIDE_MODEL;
          const canAttemptQuotaAutoSwap =
            autoSwapOnQuotaLimitEnabled &&
            supportsHostedAutoQuotaFallback &&
            isQuotaLimit &&
            !alreadyOnTempAuto &&
            !quotaAutoSwapAttemptedRef.current;

          if (canAttemptQuotaAutoSwap) {
            quotaAutoSwapAttemptedRef.current = true;
            setTempModelOverride(TEMP_QUOTA_OVERRIDE_MODEL);

            const statusId = uid("status");
            buffersRef.current.byId.set(statusId, {
              kind: "status",
              id: statusId,
              lines: [
                "Quota limit reached; temporarily switching to Auto and continuing...",
              ],
            });
            buffersRef.current.order.push(statusId);
            refreshDerived();

            currentInput = [
              ...currentInput,
              {
                type: "message",
                role: "user",
                content: "Keep going.",
              },
            ];

            buffersRef.current.byId.delete(statusId);
            buffersRef.current.order = buffersRef.current.order.filter(
              (id: string) => id !== statusId,
            );
            refreshDerived();

            buffersRef.current.interrupted = false;
            continue;
          }

          // Empty LLM response retry (e.g. Opus 4.6 occasionally returns no content).
          // Retry 1: same input unchanged. Retry 2: append system reminder nudging the model.
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

            // Only append a nudge on the last attempt
            if (attempt >= EMPTY_RESPONSE_MAX_RETRIES) {
              currentInput = [
                ...currentInput,
                {
                  type: "message" as const,
                  role: "system" as const,
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

            // Empty-response retry starts a new request/run, so refresh OTIDs.
            currentInput = refreshInputOtidsForNewRequest(currentInput);
            buffersRef.current.interrupted = false;
            continue;
          }

          // Check if this is a retriable error (transient LLM API error)
          const retriable = await isRetriableError(
            stopReasonToHandle,
            lastRunId,
            detailFromRun ?? latestErrorText ?? fallbackError,
          );

          if (
            retriable &&
            llmApiErrorRetriesRef.current < LLM_API_ERROR_MAX_RETRIES
          ) {
            // Do NOT replay the same run for terminal post-stream errors
            // (e.g. llm_api_error). A retry should create a new run.

            llmApiErrorRetriesRef.current += 1;
            const attempt = llmApiErrorRetriesRef.current;

            // Provider fallback: after 1 retry against Anthropic, switch to Bedrock
            if (
              attempt >= 2 &&
              !providerFallbackAttemptedRef.current &&
              currentModelId
            ) {
              const fallbackId = PROVIDER_FALLBACK_MAP[currentModelId];
              const fallbackHandle = fallbackId
                ? getModelInfo(fallbackId)?.handle
                : undefined;
              if (fallbackHandle) {
                providerFallbackAttemptedRef.current = true;
                setTempModelOverride(fallbackHandle);

                const statusId = uid("status");
                buffersRef.current.byId.set(statusId, {
                  kind: "status",
                  id: statusId,
                  lines: ["Anthropic API error; falling back to Bedrock..."],
                });
                buffersRef.current.order.push(statusId);
                refreshDerived();

                currentInput = refreshInputOtidsForNewRequest(currentInput);
                highestSeqIdSeen = null;
                buffersRef.current.interrupted = false;
                continue;
              }
            }

            const delayMs = getRetryDelayMs({
              category: "transient_provider",
              attempt,
              detail: detailFromRun ?? fallbackError,
            });

            // Log the error that triggered the retry
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

            // Show subtle grey status message (skip for silently-retried errors)
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

            // Wait before retry (check abort signal periodically for ESC cancellation)
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
              await new Promise((resolve) => setTimeout(resolve, 100)); // Check every 100ms
            }

            // Remove status message
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
              // Local already appended the turn input before the failed run.
              // Continue from persisted conversation state instead of duplicating
              // user/approval messages into the retry run.
              currentInput = retryFromPersistedLocalState
                ? []
                : refreshInputOtidsForNewRequest(currentInput);
              // Reset seq_id threshold — new run starts from seq_id 1, not a resume.
              highestSeqIdSeen = null;
              // Reset interrupted flag so retry stream chunks are processed
              buffersRef.current.interrupted = false;
              // Retry by continuing the while loop with fresh OTIDs.
              continue;
            }
            // User pressed ESC - fall through to error handling
          }

          // Reset retry counters on non-retriable error (or max retries exceeded)
          llmApiErrorRetriesRef.current = 0;
          emptyResponseRetriesRef.current = 0;
          conversationBusyRetriesRef.current = 0;

          // Mark incomplete tool calls as finished to prevent stuck blinking UI
          markIncompleteToolsAsCancelled(
            buffersRef.current,
            true,
            "stream_error",
          );

          // If we have a client-side stream error with no run_id, show it directly.
          // When lastRunId is present, prefer the richer server-side error details below.
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

            // Restore dequeued message to input on error
            if (lastDequeuedMessageRef.current) {
              setRestoredInput(lastDequeuedMessageRef.current);
              lastDequeuedMessageRef.current = null;
            }
            // Clear any remaining queue on error
            tuiQueueRef.current?.clear("error");

            setStreaming(false);
            sendDesktopNotification("Stream error", "error"); // Notify user of error
            refreshDerived();
            resetTrajectoryBases();
            return;
          }

          // Shared telemetry options for the primary error appendError call.
          // The first appendError in each branch carries the telemetry event;
          // subsequent hint lines pass `true` to skip duplicate tracking.
          const errorTelemetryBase = {
            errorType: stopReasonToHandle || "unknown_stop_reason",
            context: "message_stream" as const,
            runId: lastRunId ?? undefined,
          };

          // Fetch error details from the run if available (server-side errors)
          if (lastRunId) {
            try {
              const run = await getBackend().retrieveRun(lastRunId);

              // Check if run has error information in metadata
              if (run.metadata?.error) {
                const errorData = run.metadata.error as {
                  type?: string;
                  message?: string;
                  detail?: string;
                };

                const serverErrorDetail =
                  errorData.detail || errorData.message || null;

                // Pass structured error data to our formatter
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

                // Encrypted content errors are self-explanatory (include /clear advice)
                // — skip the generic "Something went wrong?" hint
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
                  // Show appropriate error hint based on stop reason
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
                // No error metadata, show generic error with run info
                appendError(
                  `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})`,
                  {
                    ...errorTelemetryBase,
                    errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                  },
                );

                // Show appropriate error hint based on stop reason
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
              // If we can't fetch error details, show generic error
              appendError(
                `An error occurred during agent execution\n(run_id: ${lastRunId}, stop_reason: ${stopReason})\n(Unable to fetch additional error details from server)`,
                {
                  ...errorTelemetryBase,
                  errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
                },
              );

              // Show appropriate error hint based on stop reason
              appendError(
                getErrorHintForStopReason(
                  stopReasonToHandle,
                  currentModelId,
                  llmConfigRef.current?.model_endpoint_type,
                ),
                true,
              );

              // Restore dequeued message to input on error
              if (lastDequeuedMessageRef.current) {
                setRestoredInput(lastDequeuedMessageRef.current);
                lastDequeuedMessageRef.current = null;
              }
              // Clear any remaining queue on error
              tuiQueueRef.current?.clear("error");

              setStreaming(false);
              sendDesktopNotification();
              refreshDerived();
              resetTrajectoryBases();
              return;
            }
          } else {
            // No run_id available - but this is unusual since errors should have run_ids
            appendError(
              `An error occurred during agent execution\n(stop_reason: ${stopReason})`,
              {
                ...errorTelemetryBase,
                errorMessage: `Stream stopped with reason: ${stopReasonToHandle}`,
              },
            );

            // Show appropriate error hint based on stop reason
            appendError(
              getErrorHintForStopReason(
                stopReasonToHandle,
                currentModelId,
                llmConfigRef.current?.model_endpoint_type,
              ),
              true,
            );
          }

          // Restore dequeued message to input on error
          if (lastDequeuedMessageRef.current) {
            setRestoredInput(lastDequeuedMessageRef.current);
            lastDequeuedMessageRef.current = null;
          }
          // Clear any remaining queue on error
          tuiQueueRef.current?.clear("error");

          setStreaming(false);
          sendDesktopNotification("Execution error", "error"); // Notify user of error
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

        // Mark incomplete tool calls as cancelled to prevent stuck blinking UI
        markIncompleteToolsAsCancelled(
          buffersRef.current,
          true,
          e instanceof APIUserAbortError ? "user_interrupt" : "stream_error",
        );

        // If using eager cancel and this is an abort error, silently ignore it
        // The user already got "Stream interrupted by user" feedback from handleInterrupt
        if (EAGER_CANCEL && e instanceof APIUserAbortError) {
          setStreaming(false);
          refreshDerived();
          return;
        }

        // Use comprehensive error formatting
        const errorDetails = formatErrorDetails(e, agentIdRef.current);
        appendError(errorDetails, {
          ...extractErrorMeta(e),
          errorMessage: e instanceof Error ? e.message : String(e),
          context: "message_stream",
          runId: currentRunId,
        });
        appendError(ERROR_FEEDBACK_HINT, true);

        // Restore dequeued message to input on error (Input component will only use if empty)
        if (lastDequeuedMessageRef.current) {
          setRestoredInput(lastDequeuedMessageRef.current);
          lastDequeuedMessageRef.current = null;
        }
        // Clear any remaining queue on error
        tuiQueueRef.current?.clear("error");

        setStreaming(false);
        sendDesktopNotification("Processing error", "error"); // Notify user of error
        refreshDerived();
        resetTrajectoryBases();
      } finally {
        if (!preserveTranscriptStartForApproval) {
          pendingTranscriptStartLineIndexRef.current = null;
        }

        // Check if this conversation was superseded by an ESC interrupt
        const isStale = myGeneration !== conversationGenerationRef.current;

        abortControllerRef.current = null;

        // Decrement BEFORE bumping the epoch so that when the dequeue effect
        // fires synchronously (Ink legacy mode), processingConversationRef.current
        // already reflects the true count. The defer gate checks === 0 to confirm
        // no more nested processConversation calls are outstanding.
        if (!isStale) {
          processingConversationRef.current = Math.max(
            0,
            processingConversationRef.current - 1,
          );
        }

        // Trigger dequeue effect now that processConversation is no longer active.
        // The dequeue effect checks abortControllerRef (a ref, not state), so it
        // won't re-run on its own — bump dequeueEpoch to force re-evaluation.
        // Only bump for normal completions — if stale (ESC was pressed), the user
        // cancelled and queued messages should NOT be auto-submitted.
        if (!isStale && (tuiQueueRef.current?.length ?? 0) > 0) {
          setDequeueEpoch((e: number) => e + 1);
        }
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
