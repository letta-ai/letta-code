import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ApprovalResult } from "@/agent/approval-execution";
import { fetchRunErrorInfo } from "@/agent/approval-recovery";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import {
  getConversationId,
  getCurrentAgentId,
  setConversationId,
  setCurrentAgentId,
} from "@/agent/context";
import { regenerateConversationDescription } from "@/agent/conversation-description";
import {
  getStreamToolContextId,
  type sendMessageStream,
} from "@/agent/message";
import {
  getRetryDelayMs,
  isEmptyResponseRetryable,
  normalizeStreamErrorTypeToStopReason,
  rebuildInputWithFreshDenials,
  refreshInputOtidsForNewRequest,
} from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { createBuffers, toLines } from "@/cli/helpers/accumulator";
import type { ContextTracker } from "@/cli/helpers/context-tracker";
import { getRetryStatusMessage } from "@/cli/helpers/error-formatter";
import {
  getReflectionSettings,
  type ReflectionSettings,
  type ReflectionTrigger,
  shouldFireStepCountTrigger,
} from "@/cli/helpers/memory-reminder";
import {
  AUTO_REFLECTION_DESCRIPTION,
  launchReflectionSubagent,
} from "@/cli/helpers/reflection-launcher";
import {
  appendTranscriptDeltaJsonl,
  getReflectionTranscriptState,
} from "@/cli/helpers/reflection-transcript";
import { drainStreamWithResume } from "@/cli/helpers/stream";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "@/reminders/engine";
import { buildListenReminderContext } from "@/reminders/listen-context";
import {
  type SharedReminderState,
  syncReminderStateFromContextTracker,
} from "@/reminders/state";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { extractTelemetryInputText } from "@/telemetry/input";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import type { StopReasonType, StreamDelta } from "@/types/protocol_v2";
import { debugLog, debugWarn, isDebugEnabled } from "@/utils/debug";
import {
  EMPTY_RESPONSE_MAX_RETRIES,
  LLM_API_ERROR_MAX_RETRIES,
  PROVIDER_FALLBACK_NOTICE,
} from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  consumeInterruptQueue,
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  getInterruptApprovalsForEmission,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
} from "./interrupts";
import {
  getOrCreateConversationPermissionModeStateRef,
  persistPermissionModeMapForRuntime,
  pruneConversationPermissionModeStateIfDefault,
} from "./permission-mode";
import {
  emitCanonicalMessageDelta,
  emitDeviceStatusIfOpen,
  emitInterruptedStatusDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitRuntimeStateUpdates,
  setLoopStatus,
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
  getApprovalToolCallDesyncErrorText,
  isRetriablePostStopError,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearActiveRunState,
  clearRecoveredApprovalStateForScope,
  evictConversationRuntimeIfIdle,
} from "./runtime";
import { normalizeCwdAgentId } from "./scope";
import {
  isApprovalOnlyInput,
  markAwaitingAcceptedApprovalContinuationRunId,
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import { injectQueuedSkillContent } from "./skill-injection";
import type { ListenerTransport } from "./transport";
import { handleApprovalStop } from "./turn-approval";
import type {
  ConversationRuntime,
  InboundMessagePayload,
  IncomingMessage,
} from "./types";
import { ensureListenerWarmStateForTurn } from "./warmup";

function trackListenerUserInput(
  messages: InboundMessagePayload[],
  modelId: string,
): void {
  for (const message of messages) {
    if (!("role" in message) || message.role !== "user") {
      continue;
    }

    const inputText = extractTelemetryInputText(message.content);
    if (inputText.length === 0) {
      continue;
    }

    telemetry.trackUserInput(inputText, "user", modelId);
  }
}

export const __listenerTurnTestUtils = {
  trackListenerUserInput,
  maybeLaunchPostTurnChannelReflection,
};

function escapeTaskNotificationSummary(summary: string): string {
  return summary
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMaybeLaunchReflectionSubagent(params: {
  runtime: ConversationRuntime;
  socket: ListenerTransport;
  agentId: string;
  conversationId: string;
  cachedAgent?: AgentState | null;
}): (triggerSource: Exclude<ReflectionTrigger, "off">) => Promise<boolean> {
  return async (triggerSource) => {
    const { runtime, socket, agentId, conversationId, cachedAgent } = params;

    if (!agentId) {
      return false;
    }

    const result = await launchReflectionSubagent({
      agentId,
      conversationId,
      memfsEnabled: settingsManager.isMemfsEnabled(agentId),
      triggerSource,
      description: AUTO_REFLECTION_DESCRIPTION,
      systemPrompt: cachedAgent?.system ?? undefined,
      recompileByConversation:
        runtime.listener.systemPromptRecompileByConversation,
      recompileQueuedByConversation:
        runtime.listener.queuedSystemPromptRecompileByConversation,
      onCompletionMessage: async (completionMessage) => {
        const notificationXml = `<task-notification><summary>${escapeTaskNotificationSummary(
          completionMessage,
        )}</summary></task-notification>`;
        emitCanonicalMessageDelta(
          socket,
          runtime,
          {
            type: "message",
            id: `user-msg-${crypto.randomUUID()}`,
            date: new Date().toISOString(),
            message_type: "user_message",
            content: [{ type: "text", text: notificationXml }],
          } as StreamDelta,
          {
            agent_id: agentId,
            conversation_id: conversationId,
          },
        );
      },
    });
    return result.launched;
  };
}

type PostTurnReflectionLauncher = (
  triggerSource: Exclude<ReflectionTrigger, "off">,
) => Promise<boolean>;

async function maybeLaunchPostTurnChannelReflection(params: {
  hasChannelTurnSources: boolean;
  agentId?: string | null;
  conversationId: string;
  memfsEnabled: boolean;
  reflectionSettings: ReflectionSettings;
  reminderState: SharedReminderState;
  contextTracker: ContextTracker;
  launch: PostTurnReflectionLauncher;
  getTranscriptState?: typeof getReflectionTranscriptState;
}): Promise<boolean> {
  if (
    !params.hasChannelTurnSources ||
    !params.agentId ||
    !params.memfsEnabled
  ) {
    return false;
  }

  switch (params.reflectionSettings.trigger) {
    case "off":
      return false;
    case "compaction-event": {
      syncReminderStateFromContextTracker(
        params.reminderState,
        params.contextTracker,
      );
      if (!params.reminderState.pendingReflectionTrigger) {
        return false;
      }
      params.reminderState.pendingReflectionTrigger = false;
      return params.launch("compaction-event");
    }
    case "step-count": {
      const readTranscriptState =
        params.getTranscriptState ?? getReflectionTranscriptState;
      const transcriptState = await readTranscriptState(
        params.agentId,
        params.conversationId,
      );
      if (
        !shouldFireStepCountTrigger(
          transcriptState.turns_since_last_successful_reflection,
          params.reflectionSettings,
        )
      ) {
        return false;
      }
      return params.launch("step-count");
    }
  }
}

function finalizeInterruptedTurn(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  params: {
    runId?: string | null;
    agentId?: string | null;
    conversationId: string;
  },
): void {
  const scope = {
    agent_id: params.agentId ?? null,
    conversation_id: params.conversationId,
  };
  const alreadyProjected =
    runtime.cancelRequested &&
    !runtime.isProcessing &&
    runtime.loopStatus === "WAITING_ON_INPUT" &&
    runtime.activeRunId === null &&
    runtime.activeAbortController === null;

  runtime.lastStopReason = "cancelled";
  runtime.isProcessing = false;

  if (!alreadyProjected) {
    emitInterruptedStatusDelta(socket, runtime, {
      runId: params.runId,
      agentId: params.agentId,
      conversationId: params.conversationId,
    });
    clearActiveRunState(runtime);
    setLoopStatus(runtime, "WAITING_ON_INPUT", scope);
    emitRuntimeStateUpdates(runtime, scope);
  }
}

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

  runtime.isProcessing = true;
  runtime.cancelRequested = false;
  runtime.lastStopReason = null;
  runtime.lastTerminalLoopErrorMessage = null;
  const turnAbortController = new AbortController();
  runtime.activeAbortController = turnAbortController;
  const turnAbortSignal = turnAbortController.signal;
  runtime.activeWorkingDirectory = turnWorkingDirectory;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = new Date().toISOString();
  runtime.activeExecutingToolCallIds = [];
  setLoopStatus(runtime, "SENDING_API_REQUEST", {
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

  try {
    telemetry.setCurrentAgentId(agentId ?? null);

    if (!agentId) {
      runtime.isProcessing = false;
      clearActiveRunState(runtime);
      setLoopStatus(runtime, "WAITING_ON_INPUT", {
        conversation_id: conversationId,
      });
      emitRuntimeStateUpdates(runtime, {
        conversation_id: conversationId,
      });
      return;
    }

    // Ensure local per-agent state is ready before reminders and tool execution.
    let listenAgentMetadata = await ensureListenerWarmStateForTurn(
      runtime.listener,
      {
        agentId,
        conversationId,
      },
    );

    // Set agent context for tools that need it (e.g., Skill tool)
    setCurrentAgentId(agentId);
    setConversationId(conversationId);

    if (isDebugEnabled()) {
      console.log(
        `[Listen] Handling message: agentId=${agentId}, requestedConversationId=${requestedConversationId}, conversationId=${conversationId}`,
      );
    }

    if (connectionId) {
      onStatusChange?.("processing", connectionId);
    }

    const { normalizeInboundMessages } = await import(
      "@/websocket/listener/queue"
    );
    const normalizedMessages = await normalizeInboundMessages(
      msg.messages,
      undefined,
      {
        imageFailureMode:
          (msg.channelTurnSources?.length ?? 0) > 0 ? "drop" : "strict",
      },
    );
    trackListenerUserInput(normalizedMessages, "unknown");
    const messagesToSend: Array<MessageCreate | ApprovalCreate> = [];
    let turnToolContextId: string | null = null;
    let queuedInterruptedToolCallIds: string[] = [];

    const consumed = consumeInterruptQueue(
      runtime,
      agentId || "",
      conversationId,
    );
    if (consumed) {
      messagesToSend.push(consumed.approvalMessage);
      queuedInterruptedToolCallIds = consumed.interruptedToolCallIds;
    }

    messagesToSend.push(
      ...normalizedMessages.map((m) =>
        "content" in m && !m.otid
          ? {
              ...m,
              // Ensure every client-originated message carries an OTID so the
              // echoed user_message can reconcile optimistic local transcript
              // rows with the later canonical backend message.id.
              otid:
                "client_message_id" in m &&
                typeof m.client_message_id === "string"
                  ? m.client_message_id
                  : crypto.randomUUID(),
            }
          : m,
      ),
    );

    const firstMessage = normalizedMessages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    let cachedAgent: AgentState | null = null;

    if (!isApprovalMessage) {
      try {
        syncReminderStateFromContextTracker(
          runtime.reminderState,
          runtime.contextTracker,
        );
        if (agentId) {
          try {
            cachedAgent = (await getBackend().retrieveAgent(
              agentId,
            )) as AgentState;
          } catch {
            // Best-effort only. If the fetch fails, reminder and tool prep
            // will fall back to the existing null/placeholder behavior.
          }
        }

        if (!runtime.reminderState.hasSentAgentInfo && cachedAgent) {
          listenAgentMetadata = {
            name: cachedAgent.name ?? null,
            description: cachedAgent.description ?? null,
            lastRunAt:
              (cachedAgent as { last_run_completion?: string | null })
                .last_run_completion ?? null,
          };
        }
        const reflectionSettings = getReflectionSettings(
          agentId || undefined,
          turnWorkingDirectory,
        );
        const { parts: reminderParts } = await buildSharedReminderParts(
          buildListenReminderContext({
            agentId: agentId || "",
            conversationId,
            agentName: listenAgentMetadata?.name ?? null,
            agentDescription: listenAgentMetadata?.description ?? null,
            agentLastRunAt: listenAgentMetadata?.lastRunAt ?? null,
            state: runtime.reminderState,
            reflectionSettings,
            maybeLaunchReflectionSubagent: agentId
              ? buildMaybeLaunchReflectionSubagent({
                  runtime,
                  socket,
                  agentId,
                  conversationId,
                  cachedAgent,
                })
              : undefined,
            workingDirectory: turnWorkingDirectory,
          }),
        );

        if (reminderParts.length > 0) {
          for (const m of messagesToSend) {
            if ("role" in m && m.role === "user" && "content" in m) {
              m.content = prependReminderPartsToContent(
                m.content,
                reminderParts,
              );
              break;
            }
          }
        }
      } catch (err) {
        // Reminder injection is best-effort — failures must not prevent
        // the user message from being sent to the agent.
        trackBoundaryError({
          errorType: "listener_reminder_build_failed",
          error: err,
          context: "listener_turn_reminders",
        });
        if (isDebugEnabled()) {
          console.error("[Listen] Failed to build reminder parts:", err);
        }
      }
    }

    let currentInput = messagesToSend;
    const providerFallback = createProviderFallbackState(cachedAgent);
    let pendingNormalizationInterruptedToolCallIds = [
      ...queuedInterruptedToolCallIds,
    ];
    const preparedToolContext = await prepareToolExecutionContextForScope({
      agentId,
      conversationId,
      clientToolAllowlist: msg.clientToolAllowlist,
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      cachedAgent,
      channelTurnSources: msg.channelTurnSources,
    });
    runtime.currentToolset = preparedToolContext.toolset;
    runtime.currentToolsetPreference = preparedToolContext.toolsetPreference;
    runtime.currentLoadedTools =
      preparedToolContext.preparedToolContext.loadedToolNames;
    const buildSendOptions = (): Parameters<typeof sendMessageStream>[2] => ({
      agentId,
      streamTokens: true,
      background: true,
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
      preparedToolContext: preparedToolContext.preparedToolContext,
      skipImageNormalization: true,
      ...(providerFallback.overrideModel
        ? { overrideModel: providerFallback.overrideModel }
        : {}),
      // Forward cloud-api's per-WS acting user id so the outbound
      // createMessage HTTP call carries X-Letta-Acting-User-Id and
      // cloud can attribute credits to the actual sender on
      // multi-user sandboxes.
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

    const isPureApprovalContinuation = isApprovalOnlyInput(currentInput);
    const currentInputWithSkillContent = injectQueuedSkillContent(currentInput);

    let stream = isPureApprovalContinuation
      ? await sendApprovalContinuationWithRetry(
          conversationId,
          currentInputWithSkillContent,
          buildSendOptions(),
          socket,
          runtime,
          turnAbortSignal,
          { providerFallback },
        )
      : await sendMessageStreamWithRetry(
          conversationId,
          currentInputWithSkillContent,
          buildSendOptions(),
          socket,
          runtime,
          turnAbortSignal,
          { providerFallback },
        );
    currentInput = currentInputWithSkillContent;
    if (!stream) {
      return;
    }
    pendingNormalizationInterruptedToolCallIds = [];
    markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
    setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
      agent_id: agentId,
      conversation_id: conversationId,
    });

    turnToolContextId = getStreamToolContextId(
      stream as Stream<LettaStreamingResponse>,
    );
    let runIdSent = false;
    let runId: string | undefined;
    const buffers = createBuffers(agentId);

    // eslint-disable-next-line no-constant-condition
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
          if (runtime.cancelRequested) {
            return undefined;
          }
          const maybeRunId = (chunk as { run_id?: unknown }).run_id;
          if (typeof maybeRunId === "string") {
            runId = maybeRunId;
            if (runtime.activeRunId !== maybeRunId) {
              runtime.activeRunId = maybeRunId;
            }
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
                cancelRequested: runtime.cancelRequested,
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
      lastApprovalContinuationAccepted = false;

      if (stopReason === "end_turn" && runtime.cancelRequested) {
        finalizeInterruptedTurn(socket, runtime, {
          runId: runId || runtime.activeRunId,
          agentId: agentId ?? null,
          conversationId,
        });
        break;
      }

      if (stopReason === "end_turn") {
        try {
          const transcriptLines = toLines(buffers);
          if (transcriptLines.length > 0) {
            await appendTranscriptDeltaJsonl(
              agentId || "",
              conversationId,
              transcriptLines,
            );
          }
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
        try {
          const reflectionSettings = getReflectionSettings(
            agentId || undefined,
            turnWorkingDirectory,
          );
          await maybeLaunchPostTurnChannelReflection({
            hasChannelTurnSources: (msg.channelTurnSources?.length ?? 0) > 0,
            agentId,
            conversationId,
            memfsEnabled: Boolean(
              agentId && settingsManager.isMemfsEnabled(agentId),
            ),
            reflectionSettings,
            reminderState: runtime.reminderState,
            contextTracker: runtime.contextTracker,
            launch: buildMaybeLaunchReflectionSubagent({
              runtime,
              socket,
              agentId: agentId || "",
              conversationId,
              cachedAgent,
            }),
          });
        } catch (reflectionError) {
          debugWarn(
            "memory",
            `Failed to evaluate post-turn channel reflection: ${
              reflectionError instanceof Error
                ? reflectionError.message
                : String(reflectionError)
            }`,
          );
        }
        if (runtime.contextTracker.pendingConversationDescriptionRegeneration) {
          runtime.contextTracker.pendingConversationDescriptionRegeneration = false;
          void regenerateConversationDescription(conversationId);
        }
        runtime.lastStopReason = "end_turn";
        runtime.isProcessing = false;
        clearActiveRunState(runtime);
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        break;
      }

      if (stopReason === "cancelled") {
        finalizeInterruptedTurn(socket, runtime, {
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
            currentInput = rebuildInputWithFreshDenials(
              currentInput,
              existingApprovals ?? [],
              "Auto-denied: stale approval from interrupted session",
            );
          } catch {
            currentInput = rebuildInputWithFreshDenials(currentInput, [], "");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const isPureApprovalContinuationRetry =
            isApprovalOnlyInput(currentInput);
          const retryInputWithSkillContent =
            injectQueuedSkillContent(currentInput);
          stream = isPureApprovalContinuationRetry
            ? await sendApprovalContinuationWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              );
          currentInput = retryInputWithSkillContent;
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
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
            currentInput = [
              ...currentInput,
              {
                type: "message" as const,
                role: "system" as const,
                content:
                  "<system-reminder>The previous response was empty. Please provide a response with either text content or a tool call.</system-reminder>",
              },
            ];
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
          currentInput = refreshInputOtidsForNewRequest(currentInput);

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const isPureApprovalContinuationRetry =
            isApprovalOnlyInput(currentInput);
          const retryInputWithSkillContent =
            injectQueuedSkillContent(currentInput);
          stream = isPureApprovalContinuationRetry
            ? await sendApprovalContinuationWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              );
          currentInput = retryInputWithSkillContent;
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
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
          currentInput = refreshInputOtidsForNewRequest(currentInput);

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          const isPureApprovalContinuationRetry =
            isApprovalOnlyInput(currentInput);
          const retryInputWithSkillContent =
            injectQueuedSkillContent(currentInput);
          stream = isPureApprovalContinuationRetry
            ? await sendApprovalContinuationWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
                { providerFallback },
              );
          currentInput = retryInputWithSkillContent;
          if (!stream) {
            return;
          }
          pendingNormalizationInterruptedToolCallIds = [];
          markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
          setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          turnToolContextId = getStreamToolContextId(
            stream as Stream<LettaStreamingResponse>,
          );
          continue;
        }

        const effectiveStopReason: StopReasonType = runtime.cancelRequested
          ? "cancelled"
          : (stopReason as StopReasonType) || "error";

        if (effectiveStopReason === "cancelled") {
          finalizeInterruptedTurn(socket, runtime, {
            runId: runId || runtime.activeRunId,
            agentId: agentId ?? null,
            conversationId,
          });
          break;
        }

        runtime.lastStopReason = effectiveStopReason;
        runtime.isProcessing = false;
        clearActiveRunState(runtime);
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        const errorMessage =
          errorDetail || `Unexpected stop reason: ${stopReason}`;

        const formattedError = emitLoopErrorNotice(socket, runtime, {
          message: errorMessage,
          stopReason: effectiveStopReason,
          isTerminal: true,
          runId: runId,
          agentId,
          conversationId,
          runErrorInfo: runErrorInfo ?? undefined,
          cancelRequested: runtime.cancelRequested,
          abortSignal: turnAbortSignal,
        });
        runtime.lastTerminalLoopErrorMessage = formattedError ?? errorMessage;
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
        currentInput,
        pendingNormalizationInterruptedToolCallIds,
        turnToolContextId,
        buildSendOptions,
        providerFallback,
      });
      if (approvalResult.terminated || !approvalResult.stream) {
        return;
      }
      stream = approvalResult.stream;
      currentInput = approvalResult.currentInput;
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
    if (runtime.cancelRequested) {
      if (!lastApprovalContinuationAccepted) {
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

      finalizeInterruptedTurn(socket, runtime, {
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        agentId: agentId || null,
        conversationId,
      });

      return;
    }

    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    clearActiveRunState(runtime);
    setLoopStatus(runtime, "WAITING_ON_INPUT", {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });
    emitRuntimeStateUpdates(runtime, {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });

    const errorMessage = error instanceof Error ? error.message : String(error);
    const formattedError = emitLoopErrorNotice(socket, runtime, {
      message: errorMessage,
      stopReason: "error",
      isTerminal: true,
      agentId: agentId || undefined,
      conversationId,
      error,
      cancelRequested: runtime.cancelRequested,
      abortSignal: turnAbortSignal,
    });
    runtime.lastTerminalLoopErrorMessage = formattedError ?? errorMessage;
    if (isDebugEnabled()) {
      console.error("[Listen] Error handling message:", error);
    }
  } finally {
    // Prune lean defaults only at turn-finalization boundaries (never during
    // mid-turn mode changes), then persist the canonical map.
    pruneConversationPermissionModeStateIfDefault(
      runtime.listener,
      normalizedAgentId,
      conversationId,
    );
    persistPermissionModeMapForRuntime(runtime.listener);

    // Emit device status after persistence/pruning so UI reflects the final
    // canonical state for this scope.
    emitDeviceStatusIfOpen(runtime, {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });

    try {
      const currentConversationId = getConversationId();
      let currentAgentId: string | null = null;
      try {
        currentAgentId = getCurrentAgentId();
      } catch {
        currentAgentId = null;
      }

      if (
        currentAgentId === (agentId ?? null) &&
        currentConversationId === conversationId
      ) {
        setCurrentAgentId(null);
        setConversationId(null);
      }
    } catch {
      // Best-effort cleanup only. Never let teardown obscure the turn result.
    }

    runtime.activeAbortController = null;
    runtime.cancelRequested = false;
    runtime.isRecoveringApprovals = false;
    runtime.activeExecutingToolCallIds = [];
    evictConversationRuntimeIfIdle(runtime);
  }
}
