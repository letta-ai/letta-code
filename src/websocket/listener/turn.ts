import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  type ApprovalResult,
  executeApprovalBatch,
} from "../../agent/approval-execution";
import { fetchRunErrorDetail } from "../../agent/approval-recovery";
import { getResumeData } from "../../agent/check-approval";
import { getClient } from "../../agent/client";
import {
  getStreamToolContextId,
  type sendMessageStream,
} from "../../agent/message";
import {
  getRetryDelayMs,
  isEmptyResponseRetryable,
  rebuildInputWithFreshDenials,
} from "../../agent/turn-recovery-policy";
import { createBuffers } from "../../cli/helpers/accumulator";
import { classifyApprovals } from "../../cli/helpers/approvalClassification";
import { getRetryStatusMessage } from "../../cli/helpers/errorFormatter";
import { drainStreamWithResume } from "../../cli/helpers/stream";
import { computeDiffPreviews } from "../../helpers/diffPreview";
import {
  buildSharedReminderParts,
  prependReminderPartsToContent,
} from "../../reminders/engine";
import { buildListenReminderContext } from "../../reminders/listenContext";
import { getPlanModeReminder } from "../../reminders/planModeReminder";
import { isInteractiveApprovalTool } from "../../tools/interactivePolicy";
import type {
  ApprovalResponseDecision,
  ControlRequest,
  StopReasonType,
  StreamDelta,
} from "../../types/protocol_v2";
import { isDebugEnabled } from "../../utils/debug";
import {
  clearPendingApprovalBatchIds,
  collectApprovalResultToolCallIds,
  collectDecisionToolCallIds,
  requestApprovalOverWS,
  validateApprovalResultIds,
} from "./approval";
import {
  EMPTY_RESPONSE_MAX_RETRIES,
  LLM_API_ERROR_MAX_RETRIES,
} from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  consumeInterruptQueue,
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
  getInterruptApprovalsForEmission,
  normalizeExecutionResultsForInterruptParity,
  normalizeToolReturnWireMessage,
  populateInterruptQueue,
} from "./interrupts";
import {
  emitCanonicalMessageDelta,
  emitInterruptedStatusDelta,
  emitLoopErrorDelta,
  emitLoopStatusUpdate,
  emitRetryDelta,
  emitRuntimeStateUpdates,
  emitStatusDelta,
  setLoopStatus,
} from "./protocol-outbound";
import {
  debugLogApprovalResumeState,
  isRetriablePostStopError,
  shouldAttemptPostStopApprovalRecovery,
} from "./recovery";
import {
  clearActiveRunState,
  clearRecoveredApprovalStateForScope,
} from "./runtime";
import { normalizeCwdAgentId } from "./scope";
import {
  isApprovalOnlyInput,
  markAwaitingAcceptedApprovalContinuationRunId,
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import type { IncomingMessage, ListenerRuntime } from "./types";

export async function handleIncomingMessage(
  msg: IncomingMessage,
  socket: WebSocket,
  runtime: ListenerRuntime,
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
    runtime,
    normalizedAgentId,
    conversationId,
  );
  const msgRunIds: string[] = [];
  let postStopApprovalRecoveryRetries = 0;
  let llmApiErrorRetries = 0;
  let emptyResponseRetries = 0;
  let lastApprovalContinuationAccepted = false;

  let lastExecutionResults: ApprovalResult[] | null = null;
  let lastExecutingToolCallIds: string[] = [];
  let lastNeedsUserInputToolCallIds: string[] = [];

  runtime.isProcessing = true;
  runtime.cancelRequested = false;
  runtime.activeAbortController = new AbortController();
  runtime.activeAgentId = agentId ?? null;
  runtime.activeConversationId = conversationId;
  runtime.activeWorkingDirectory = turnWorkingDirectory;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = new Date().toISOString();
  runtime.activeExecutingToolCallIds = [];
  setLoopStatus(runtime, "SENDING_API_REQUEST", {
    agent_id: agentId ?? null,
    conversation_id: conversationId,
  });
  clearRecoveredApprovalStateForScope(runtime, {
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
      setLoopStatus(runtime, "WAITING_ON_INPUT", {
        conversation_id: conversationId,
      });
      clearActiveRunState(runtime);
      emitRuntimeStateUpdates(runtime, {
        conversation_id: conversationId,
      });
      return;
    }

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

    messagesToSend.push(...normalizedMessages);

    const firstMessage = normalizedMessages[0];
    const isApprovalMessage =
      firstMessage &&
      "type" in firstMessage &&
      firstMessage.type === "approval" &&
      "approvals" in firstMessage;

    if (!isApprovalMessage) {
      const { parts: reminderParts } = await buildSharedReminderParts(
        buildListenReminderContext({
          agentId: agentId || "",
          state: runtime.reminderState,
          resolvePlanModeReminder: getPlanModeReminder,
        }),
      );

      if (reminderParts.length > 0) {
        for (const m of messagesToSend) {
          if ("role" in m && m.role === "user" && "content" in m) {
            m.content = prependReminderPartsToContent(m.content, reminderParts);
            break;
          }
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

    let stream = isPureApprovalContinuation
      ? await sendApprovalContinuationWithRetry(
          conversationId,
          currentInput,
          buildSendOptions(),
          socket,
          runtime,
          runtime.activeAbortController.signal,
        )
      : await sendMessageStreamWithRetry(
          conversationId,
          currentInput,
          buildSendOptions(),
          socket,
          runtime,
          runtime.activeAbortController.signal,
        );
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
        runtime.activeAbortController.signal,
        undefined,
        ({ chunk, shouldOutput, errorInfo }) => {
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
      );

      const stopReason = result.stopReason;
      const approvals = result.approvals || [];
      lastApprovalContinuationAccepted = false;

      if (stopReason === "end_turn") {
        runtime.lastStopReason = "end_turn";
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        break;
      }

      if (stopReason === "cancelled") {
        runtime.lastStopReason = "cancelled";
        runtime.isProcessing = false;
        emitInterruptedStatusDelta(socket, runtime, {
          runId: runId || runtime.activeRunId,
          agentId,
          conversationId,
        });
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
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
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
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
          if (runtime.activeAbortController.signal.aborted) {
            throw new Error("Cancelled by user");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
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
          if (runtime.activeAbortController.signal.aborted) {
            throw new Error("Cancelled by user");
          }

          setLoopStatus(runtime, "SENDING_API_REQUEST", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          stream =
            currentInput.length === 1 &&
            currentInput[0] !== undefined &&
            "type" in currentInput[0] &&
            currentInput[0].type === "approval"
              ? await sendApprovalContinuationWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                )
              : await sendMessageStreamWithRetry(
                  conversationId,
                  currentInput,
                  buildSendOptions(),
                  socket,
                  runtime,
                  runtime.activeAbortController.signal,
                );
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
          runtime.lastStopReason = "cancelled";
          runtime.isProcessing = false;
          emitInterruptedStatusDelta(socket, runtime, {
            runId: runId || runtime.activeRunId,
            agentId,
            conversationId,
          });
          setLoopStatus(runtime, "WAITING_ON_INPUT", {
            agent_id: agentId,
            conversation_id: conversationId,
          });
          clearActiveRunState(runtime);
          emitRuntimeStateUpdates(runtime, {
            agent_id: agentId,
            conversation_id: conversationId,
          });

          break;
        }

        runtime.lastStopReason = effectiveStopReason;
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
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

      if (approvals.length === 0) {
        runtime.lastStopReason = "error";
        runtime.isProcessing = false;
        setLoopStatus(runtime, "WAITING_ON_INPUT", {
          agent_id: agentId,
          conversation_id: conversationId,
        });
        clearActiveRunState(runtime);
        emitRuntimeStateUpdates(runtime, {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        emitLoopErrorDelta(socket, runtime, {
          message: "requires_approval stop returned no approvals",
          stopReason: "error",
          isTerminal: true,
          agentId,
          conversationId,
        });
        break;
      }

      clearPendingApprovalBatchIds(runtime, approvals);
      // Persist origin correlation for this approval wait so a later recovery
      // can continue the same dequeued-turn run block.
      // Reset first so a replayed approval set cannot accumulate stale tool ids.
      // Then store the current approval wait's batch mapping.
      // This preserves existing semantics while keeping the map bounded.
      //
      // Note: `rememberPendingApprovalBatchIds` lives in approval.ts.
      const { rememberPendingApprovalBatchIds } = await import("./approval");
      rememberPendingApprovalBatchIds(runtime, approvals, dequeuedBatchId);

      const { autoAllowed, autoDenied, needsUserInput } =
        await classifyApprovals(approvals, {
          alwaysRequiresUserInput: isInteractiveApprovalTool,
          treatAskAsDeny: false,
          requireArgsForAutoApprove: true,
          missingNameReason: "Tool call incomplete - missing name",
          workingDirectory: turnWorkingDirectory,
        });

      lastNeedsUserInputToolCallIds = needsUserInput.map(
        (ac) => ac.approval.toolCallId,
      );
      lastExecutionResults = null;

      type Decision =
        | {
            type: "approve";
            approval: {
              toolCallId: string;
              toolName: string;
              toolArgs: string;
            };
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

      const decisions: Decision[] = [
        ...autoAllowed.map((ac) => ({
          type: "approve" as const,
          approval: ac.approval,
        })),
        ...autoDenied.map((ac) => ({
          type: "deny" as const,
          approval: ac.approval,
          reason: ac.denyReason || ac.permission.reason || "Permission denied",
        })),
      ];

      if (needsUserInput.length > 0) {
        runtime.lastStopReason = "requires_approval";
        setLoopStatus(runtime, "WAITING_ON_APPROVAL", {
          agent_id: agentId,
          conversation_id: conversationId,
        });

        for (const ac of needsUserInput) {
          const requestId = `perm-${ac.approval.toolCallId}`;
          const diffs = await computeDiffPreviews(
            ac.approval.toolName,
            ac.parsedArgs,
            turnWorkingDirectory,
          );
          const controlRequest: ControlRequest = {
            type: "control_request",
            request_id: requestId,
            request: {
              subtype: "can_use_tool",
              tool_name: ac.approval.toolName,
              input: ac.parsedArgs,
              tool_call_id: ac.approval.toolCallId,
              permission_suggestions: [],
              blocked_path: null,
              ...(diffs.length > 0 ? { diffs } : {}),
            },
            agent_id: agentId,
            conversation_id: conversationId,
          };

          const responseBody = await requestApprovalOverWS(
            runtime,
            socket,
            requestId,
            controlRequest,
          );

          if ("decision" in responseBody) {
            const response = responseBody.decision as ApprovalResponseDecision;
            if (response.behavior === "allow") {
              const finalApproval = response.updated_input
                ? {
                    ...ac.approval,
                    toolArgs: JSON.stringify(response.updated_input),
                  }
                : ac.approval;
              decisions.push({ type: "approve", approval: finalApproval });
            } else {
              decisions.push({
                type: "deny",
                approval: ac.approval,
                reason: response?.message || "Denied via WebSocket",
              });
            }
          } else {
            const denyReason = responseBody.error;
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason: denyReason,
            });
          }
        }
      }

      lastExecutingToolCallIds = decisions
        .filter(
          (decision): decision is Extract<Decision, { type: "approve" }> =>
            decision.type === "approve",
        )
        .map((decision) => decision.approval.toolCallId);
      runtime.activeExecutingToolCallIds = [...lastExecutingToolCallIds];
      setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      const executionRunId =
        runId || runtime.activeRunId || msgRunIds[msgRunIds.length - 1];
      emitToolExecutionStartedEvents(socket, runtime, {
        toolCallIds: lastExecutingToolCallIds,
        runId: executionRunId,
        agentId,
        conversationId,
      });

      const executionResults = await executeApprovalBatch(
        decisions,
        undefined,
        {
          toolContextId: turnToolContextId ?? undefined,
          abortSignal: runtime.activeAbortController.signal,
          workingDirectory: turnWorkingDirectory,
        },
      );
      const persistedExecutionResults =
        normalizeExecutionResultsForInterruptParity(
          runtime,
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
      emitToolExecutionFinishedEvents(socket, runtime, {
        approvals: persistedExecutionResults,
        runId: executionRunId,
        agentId,
        conversationId,
      });
      lastExecutionResults = persistedExecutionResults;
      emitInterruptToolReturnMessage(
        socket,
        runtime,
        persistedExecutionResults,
        runtime.activeRunId ||
          runId ||
          msgRunIds[msgRunIds.length - 1] ||
          undefined,
        "tool-return",
      );
      currentInput = [
        {
          type: "approval",
          approvals: persistedExecutionResults,
        },
      ];
      setLoopStatus(runtime, "SENDING_API_REQUEST", {
        agent_id: agentId,
        conversation_id: conversationId,
      });
      stream = await sendApprovalContinuationWithRetry(
        conversationId,
        currentInput,
        buildSendOptions(),
        socket,
        runtime,
        runtime.activeAbortController.signal,
      );
      if (!stream) {
        return;
      }
      pendingNormalizationInterruptedToolCallIds = [];
      clearPendingApprovalBatchIds(
        runtime,
        decisions.map((decision) => decision.approval),
      );
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
      markAwaitingAcceptedApprovalContinuationRunId(runtime, currentInput);
      setLoopStatus(runtime, "PROCESSING_API_RESPONSE", {
        agent_id: agentId,
        conversation_id: conversationId,
      });

      lastApprovalContinuationAccepted = true;
      runtime.activeExecutingToolCallIds = [];
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId,
        conversation_id: conversationId,
      });

      turnToolContextId = getStreamToolContextId(
        stream as Stream<LettaStreamingResponse>,
      );
    }
  } catch (error) {
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

      runtime.lastStopReason = "cancelled";
      runtime.isProcessing = false;
      emitInterruptedStatusDelta(socket, runtime, {
        runId: runtime.activeRunId || msgRunIds[msgRunIds.length - 1],
        agentId: agentId || null,
        conversationId,
      });
      setLoopStatus(runtime, "WAITING_ON_INPUT", {
        agent_id: agentId || null,
        conversation_id: conversationId,
      });
      clearActiveRunState(runtime);
      emitRuntimeStateUpdates(runtime, {
        agent_id: agentId || null,
        conversation_id: conversationId,
      });

      return;
    }

    runtime.lastStopReason = "error";
    runtime.isProcessing = false;
    setLoopStatus(runtime, "WAITING_ON_INPUT", {
      agent_id: agentId || null,
      conversation_id: conversationId,
    });
    clearActiveRunState(runtime);
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
    runtime.activeAbortController = null;
    runtime.cancelRequested = false;
    runtime.isRecoveringApprovals = false;
    runtime.activeExecutingToolCallIds = [];
  }
}
