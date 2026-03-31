import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
import { fetchRunErrorDetail } from "../../agent/approval-recovery";
import { getResumeData } from "../../agent/check-approval";
import { getClient } from "../../agent/client";
import { setConversationId, setCurrentAgentId } from "../../agent/context";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import {
  getStreamToolContextId,
  type sendMessageStream,
} from "../../agent/message";
import {
  getRetryDelayMs,
  isEmptyResponseRetryable,
  rebuildInputWithFreshDenials,
} from "../../agent/turn-recovery-policy";
import { createBuffers, toLines } from "../../cli/helpers/accumulator";
import { getRetryStatusMessage } from "../../cli/helpers/errorFormatter";
import {
  getReflectionSettings,
  type ReflectionTrigger,
} from "../../cli/helpers/memoryReminder";
import { handleMemorySubagentCompletion } from "../../cli/helpers/memorySubagentCompletion";
import { addToMessageQueue } from "../../cli/helpers/messageQueueBridge";
import {
  appendTranscriptDeltaJsonl,
  buildAutoReflectionPayload,
  buildParentMemorySnapshot,
  buildReflectionSubagentPrompt,
  finalizeAutoReflectionPayload,
} from "../../cli/helpers/reflectionTranscript";
import { drainStreamWithResume } from "../../cli/helpers/stream";
import { getSubagents } from "../../cli/helpers/subagentState";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "../../reminders/engine";
import { buildListenReminderContext } from "../../reminders/listenContext";
import { getPlanModeReminder } from "../../reminders/planModeReminder";
import { syncReminderStateFromContextTracker } from "../../reminders/state";
import { settingsManager } from "../../settings-manager";
import { trackBoundaryError } from "../../telemetry/errorReporting";
import type { StopReasonType, StreamDelta } from "../../types/protocol_v2";
import { debugLog, debugWarn, isDebugEnabled } from "../../utils/debug";
import {
  EMPTY_RESPONSE_MAX_RETRIES,
  LLM_API_ERROR_MAX_RETRIES,
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
} from "./permissionMode";
import {
  emitCanonicalMessageDelta,
  emitDeviceStatusIfOpen,
  emitInterruptedStatusDelta,
  emitLoopErrorDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitRuntimeStateUpdates,
  emitStatusDelta,
  setLoopStatus,
} from "./protocol-outbound";
import {
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
import { handleApprovalStop } from "./turn-approval";
import type { ConversationRuntime, IncomingMessage } from "./types";

const AUTO_REFLECTION_DESCRIPTION = "Reflect on recent conversations";

function hasActiveReflectionSubagent(
  agentId: string,
  conversationId: string,
): boolean {
  return getSubagents().some((agent) => {
    if (agent.type.toLowerCase() !== "reflection") {
      return false;
    }
    if (agent.status !== "pending" && agent.status !== "running") {
      return false;
    }
    if (!agent.parentAgentId) {
      return false;
    }
    const parentConversationId = agent.parentConversationId ?? "default";
    return (
      agent.parentAgentId === agentId && parentConversationId === conversationId
    );
  });
}

function buildMaybeLaunchReflectionSubagent(params: {
  runtime: ConversationRuntime;
  agentId: string;
  conversationId: string;
  workingDirectory: string;
}): (triggerSource: Exclude<ReflectionTrigger, "off">) => Promise<boolean> {
  return async (triggerSource) => {
    const { runtime, agentId, conversationId, workingDirectory } = params;

    if (!agentId || !settingsManager.isMemfsEnabled(agentId)) {
      return false;
    }

    if (hasActiveReflectionSubagent(agentId, conversationId)) {
      debugLog(
        "memory",
        `Skipping auto reflection launch (${triggerSource}) because one is already active`,
      );
      return false;
    }

    try {
      const autoPayload = await buildAutoReflectionPayload(
        agentId,
        conversationId,
      );
      if (!autoPayload) {
        debugLog(
          "memory",
          `Skipping auto reflection launch (${triggerSource}) because transcript has no new content`,
        );
        return false;
      }

      const memoryDir = getMemoryFilesystemRoot(agentId);
      const parentMemory = await buildParentMemorySnapshot(memoryDir);
      const reflectionPrompt = buildReflectionSubagentPrompt({
        transcriptPath: autoPayload.payloadPath,
        memoryDir,
        cwd: workingDirectory,
        parentMemory,
      });

      const { spawnBackgroundSubagentTask } = await import(
        "../../tools/impl/Task"
      );
      spawnBackgroundSubagentTask({
        subagentType: "reflection",
        prompt: reflectionPrompt,
        description: AUTO_REFLECTION_DESCRIPTION,
        silentCompletion: true,
        parentScope: { agentId, conversationId },
        onComplete: async ({ success, error }) => {
          await finalizeAutoReflectionPayload(
            agentId,
            conversationId,
            autoPayload.payloadPath,
            autoPayload.endSnapshotLine,
            success,
          );

          const msg = await handleMemorySubagentCompletion(
            {
              agentId,
              conversationId,
              subagentType: "reflection",
              success,
              error,
            },
            {
              recompileByConversation:
                runtime.listener.systemPromptRecompileByConversation,
              recompileQueuedByConversation:
                runtime.listener.queuedSystemPromptRecompileByConversation,
              logRecompileFailure: (message) => debugWarn("memory", message),
            },
          );

          addToMessageQueue({
            kind: "task_notification",
            text: `<task-notification><summary>${msg}</summary></task-notification>`,
            agentId,
            conversationId,
          });
        },
      });

      debugLog(
        "memory",
        `Auto-launched reflection subagent (${triggerSource})`,
      );
      return true;
    } catch (error) {
      debugWarn(
        "memory",
        `Failed to auto-launch reflection subagent (${triggerSource}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  };
}

function finalizeInterruptedTurn(
  socket: WebSocket,
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
  socket: WebSocket,
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
  // Websocket mode changes and tool implementations (EnterPlanMode/ExitPlanMode)
  // all mutate this same object in place.
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

    // Ensure memfs repo is cloned/pulled for this agent (lazy, once per session).
    const { ensureMemfsSyncedForAgent } = await import("./memfs-sync");
    await ensureMemfsSyncedForAgent(runtime.listener, agentId);

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

    const { normalizeInboundMessages } = await import("./queue");
    const normalizedMessages = await normalizeInboundMessages(msg.messages);
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
        "content" in m && !m.otid ? { ...m, otid: crypto.randomUUID() } : m,
      ),
    );

    const firstMessage = normalizedMessages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    if (!isApprovalMessage) {
      try {
        syncReminderStateFromContextTracker(
          runtime.reminderState,
          runtime.contextTracker,
        );
        const reflectionSettings = getReflectionSettings(
          agentId || undefined,
          turnWorkingDirectory,
        );
        const { parts: reminderParts } = await buildSharedReminderParts(
          buildListenReminderContext({
            agentId: agentId || "",
            conversationId,
            state: runtime.reminderState,
            reflectionSettings,
            maybeLaunchReflectionSubagent: agentId
              ? buildMaybeLaunchReflectionSubagent({
                  runtime,
                  agentId,
                  conversationId,
                  workingDirectory: turnWorkingDirectory,
                })
              : undefined,
            resolvePlanModeReminder: getPlanModeReminder,
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
    let pendingNormalizationInterruptedToolCallIds = [
      ...queuedInterruptedToolCallIds,
    ];
    const buildSendOptions = (): Parameters<typeof sendMessageStream>[2] => ({
      agentId,
      streamTokens: true,
      background: true,
      workingDirectory: turnWorkingDirectory,
      permissionModeState: turnPermissionModeState,
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
        )
      : await sendMessageStreamWithRetry(
          conversationId,
          currentInputWithSkillContent,
          buildSendOptions(),
          socket,
          runtime,
          turnAbortSignal,
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
            latestErrorText = errorInfo.message || latestErrorText;
            emitLoopErrorDelta(socket, runtime, {
              message: errorInfo.message || "Stream error",
              stopReason: (errorInfo.error_type as StopReasonType) || "error",
              isTerminal: false,
              runId: runId || errorInfo.run_id,
              agentId,
              conversationId,
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
        const errorDetail =
          latestErrorText ||
          (lastRunId ? await fetchRunErrorDetail(lastRunId) : null);

        if (
          shouldAttemptPostStopApprovalRecovery({
            stopReason,
            runIdsSeen: msgRunIds.length,
            retries: postStopApprovalRecoveryRetries,
            runErrorDetail: errorDetail,
            latestErrorText,
          })
        ) {
          postStopApprovalRecoveryRetries += 1;
          emitStatusDelta(socket, runtime, {
            message:
              "Recovering from stale approval conflict after interrupted/reconnected turn",
            level: "warning",
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          try {
            const client = await getClient();
            const agent = await client.agents.retrieve(agentId || "");
            const { pendingApprovals: existingApprovals } = await getResumeData(
              client,
              agent,
              requestedConversationId,
            );
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
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
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
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
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
        );
        if (retriable && llmApiErrorRetries < LLM_API_ERROR_MAX_RETRIES) {
          llmApiErrorRetries += 1;
          const attempt = llmApiErrorRetries;
          const delayMs = getRetryDelayMs({
            category: "transient_provider",
            attempt,
            detail: errorDetail,
          });
          const retryMessage =
            getRetryStatusMessage(errorDetail) ||
            `LLM API error encountered, retrying (attempt ${attempt}/${LLM_API_ERROR_MAX_RETRIES})...`;
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "llm_api_error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            runId: lastRunId || undefined,
            agentId,
            conversationId,
          });

          await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (turnAbortSignal.aborted) {
            throw new Error("Cancelled by user");
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
              )
            : await sendMessageStreamWithRetry(
                conversationId,
                retryInputWithSkillContent,
                buildSendOptions(),
                socket,
                runtime,
                turnAbortSignal,
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

        emitLoopErrorDelta(socket, runtime, {
          message: errorMessage,
          stopReason: effectiveStopReason,
          isTerminal: true,
          runId: runId,
          agentId,
          conversationId,
        });
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
    emitLoopErrorDelta(socket, runtime, {
      message: errorMessage,
      stopReason: "error",
      isTerminal: true,
      agentId: agentId || undefined,
      conversationId,
    });
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

    runtime.activeAbortController = null;
    runtime.cancelRequested = false;
    runtime.isRecoveringApprovals = false;
    runtime.activeExecutingToolCallIds = [];
    evictConversationRuntimeIfIdle(runtime);
  }
}
