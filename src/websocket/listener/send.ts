import { APIError } from "@letta-ai/letta-client/core/error";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type WebSocket from "ws";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "../../agent/approval-execution";
import { fetchRunErrorDetail } from "../../agent/approval-recovery";
import { getResumeData } from "../../agent/check-approval";
import { getClient } from "../../agent/client";
import { sendMessageStream } from "../../agent/message";
import {
  extractConflictDetail,
  getPreStreamErrorAction,
  getRetryDelayMs,
  parseRetryAfterHeaderMs,
} from "../../agent/turn-recovery-policy";
import { classifyApprovals } from "../../cli/helpers/approvalClassification";
import { getRetryStatusMessage } from "../../cli/helpers/errorFormatter";
import { discoverFallbackRunIdWithTimeout } from "../../cli/helpers/stream";
import { computeDiffPreviews } from "../../helpers/diffPreview";
import { isInteractiveApprovalTool } from "../../tools/interactivePolicy";
import type { ControlRequest } from "../../types/protocol_v2";
import {
  rememberPendingApprovalBatchIds,
  requestApprovalOverWS,
  resolveRecoveryBatchId,
} from "./approval";
import {
  LLM_API_ERROR_MAX_RETRIES,
  MAX_PRE_STREAM_RECOVERY,
} from "./constants";
import { getConversationWorkingDirectory } from "./cwd";
import {
  emitInterruptToolReturnMessage,
  emitToolExecutionFinishedEvents,
  emitToolExecutionStartedEvents,
} from "./interrupts";
import { getConversationPermissionModeState } from "./permissionMode";
import {
  emitRetryDelta,
  emitRuntimeStateUpdates,
  setLoopStatus,
} from "./protocol-outbound";
import {
  drainRecoveryStreamWithEmission,
  finalizeHandledRecoveryTurn,
  getApprovalContinuationRecoveryDisposition,
  isApprovalToolCallDesyncError,
} from "./recovery";
import type { ConversationRuntime } from "./types";

export function isApprovalOnlyInput(
  input: Array<MessageCreate | ApprovalCreate>,
): boolean {
  return (
    input.length === 1 &&
    input[0] !== undefined &&
    "type" in input[0] &&
    input[0].type === "approval"
  );
}

export function markAwaitingAcceptedApprovalContinuationRunId(
  runtime: ConversationRuntime,
  input: Array<MessageCreate | ApprovalCreate>,
): void {
  if (isApprovalOnlyInput(input)) {
    runtime.activeRunId = null;
  }
}

/**
 * Attempt to resolve stale pending approvals by fetching them from the backend
 * and auto-denying. This is the Phase 3 bounded recovery mechanism — it does NOT
 * touch pendingInterruptedResults (that's exclusively owned by handleIncomingMessage).
 */
async function resolveStaleApprovals(
  runtime: ConversationRuntime,
  socket: WebSocket,
  abortSignal: AbortSignal,
): Promise<Awaited<ReturnType<typeof drainRecoveryStreamWithEmission>> | null> {
  if (!runtime.agentId) return null;

  const client = await getClient();
  let agent: Awaited<ReturnType<typeof client.agents.retrieve>>;
  try {
    agent = await client.agents.retrieve(runtime.agentId);
  } catch (err) {
    if (err instanceof APIError && (err.status === 404 || err.status === 422)) {
      return null;
    }
    throw err;
  }
  const requestedConversationId =
    runtime.conversationId !== "default" ? runtime.conversationId : undefined;

  let resumeData: Awaited<ReturnType<typeof getResumeData>>;
  try {
    resumeData = await getResumeData(client, agent, requestedConversationId, {
      includeMessageHistory: false,
    });
  } catch (err) {
    if (err instanceof APIError && (err.status === 404 || err.status === 422)) {
      return null;
    }
    throw err;
  }

  let pendingApprovals = resumeData.pendingApprovals || [];
  if (pendingApprovals.length === 0) return null;
  if (abortSignal.aborted) throw new Error("Cancelled");

  const recoveryConversationId = runtime.conversationId;
  const recoveryWorkingDirectory =
    runtime.activeWorkingDirectory ??
    getConversationWorkingDirectory(
      runtime.listener,
      runtime.agentId,
      recoveryConversationId,
    );
  const scope = {
    agent_id: runtime.agentId,
    conversation_id: recoveryConversationId,
  } as const;

  while (pendingApprovals.length > 0) {
    const recoveryBatchId = resolveRecoveryBatchId(runtime, pendingApprovals);
    if (!recoveryBatchId) {
      throw new Error(
        "Ambiguous pending approval batch mapping during recovery",
      );
    }
    rememberPendingApprovalBatchIds(runtime, pendingApprovals, recoveryBatchId);

    const { autoAllowed, autoDenied, needsUserInput } = await classifyApprovals(
      pendingApprovals,
      {
        alwaysRequiresUserInput: isInteractiveApprovalTool,
        requireArgsForAutoApprove: true,
        missingNameReason: "Tool call incomplete - missing name",
        workingDirectory: recoveryWorkingDirectory,
        permissionModeState: getConversationPermissionModeState(
          runtime.listener,
          runtime.agentId,
          runtime.conversationId,
        ),
      },
    );

    const decisions: ApprovalDecision[] = [
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
      setLoopStatus(runtime, "WAITING_ON_APPROVAL", scope);
      emitRuntimeStateUpdates(runtime, scope);

      for (const ac of needsUserInput) {
        if (abortSignal.aborted) throw new Error("Cancelled");

        const requestId = `perm-${ac.approval.toolCallId}`;
        const diffs = await computeDiffPreviews(
          ac.approval.toolName,
          ac.parsedArgs,
          recoveryWorkingDirectory,
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
          agent_id: runtime.agentId,
          conversation_id: recoveryConversationId,
        };

        const responseBody = await requestApprovalOverWS(
          runtime,
          socket,
          requestId,
          controlRequest,
        );

        if ("decision" in responseBody) {
          const response = responseBody.decision;
          if (response.behavior === "allow") {
            decisions.push({
              type: "approve",
              approval: response.updated_input
                ? {
                    ...ac.approval,
                    toolArgs: JSON.stringify(response.updated_input),
                  }
                : ac.approval,
            });
          } else {
            decisions.push({
              type: "deny",
              approval: ac.approval,
              reason: response.message || "Denied via WebSocket",
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

    if (decisions.length === 0) {
      return null;
    }

    const approvedToolCallIds = decisions
      .filter(
        (
          decision,
        ): decision is Extract<ApprovalDecision, { type: "approve" }> =>
          decision.type === "approve",
      )
      .map((decision) => decision.approval.toolCallId);

    runtime.activeExecutingToolCallIds = [...approvedToolCallIds];
    setLoopStatus(runtime, "EXECUTING_CLIENT_SIDE_TOOL", scope);
    emitRuntimeStateUpdates(runtime, scope);
    emitToolExecutionStartedEvents(socket, runtime, {
      toolCallIds: approvedToolCallIds,
      runId: runtime.activeRunId ?? undefined,
      agentId: runtime.agentId ?? undefined,
      conversationId: recoveryConversationId,
    });

    try {
      const approvalResults = await executeApprovalBatch(decisions, undefined, {
        abortSignal,
        workingDirectory: recoveryWorkingDirectory,
      });
      emitToolExecutionFinishedEvents(socket, runtime, {
        approvals: approvalResults,
        runId: runtime.activeRunId ?? undefined,
        agentId: runtime.agentId ?? undefined,
        conversationId: recoveryConversationId,
      });
      emitInterruptToolReturnMessage(
        socket,
        runtime,
        approvalResults,
        runtime.activeRunId ?? undefined,
        "tool-return",
      );

      const recoveryStream = await sendApprovalContinuationWithRetry(
        recoveryConversationId,
        [{ type: "approval", approvals: approvalResults }],
        {
          agentId: runtime.agentId ?? undefined,
          streamTokens: true,
          background: true,
          workingDirectory: recoveryWorkingDirectory,
        },
        socket,
        runtime,
        abortSignal,
        { allowApprovalRecovery: false },
      );
      if (!recoveryStream) {
        throw new Error(
          "Approval recovery send resolved without a continuation stream",
        );
      }

      const drainResult = await drainRecoveryStreamWithEmission(
        recoveryStream as Stream<LettaStreamingResponse>,
        socket,
        runtime,
        {
          agentId: runtime.agentId ?? undefined,
          conversationId: recoveryConversationId,
          abortSignal,
        },
      );

      if (drainResult.stopReason === "error") {
        throw new Error("Pre-stream approval recovery drain ended with error");
      }
      if (drainResult.stopReason !== "requires_approval") {
        return drainResult;
      }
      pendingApprovals = drainResult.approvals || [];
    } finally {
      runtime.activeExecutingToolCallIds = [];
    }
  }

  return null;
}

/**
 * Wrap sendMessageStream with pre-stream error handling (retry/recovery).
 * Mirrors headless bidirectional mode's pre-stream error handling.
 */
export async function sendMessageStreamWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: WebSocket,
  runtime: ConversationRuntime,
  abortSignal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof sendMessageStream>>> {
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  const requestStartedAtMs = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    runtime.isRecoveringApprovals = false;
    setLoopStatus(runtime, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.agentId,
      conversation_id: conversationId,
    });

    try {
      return await sendMessageStream(
        conversationId,
        messages,
        opts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        if (abortSignal?.aborted) throw new Error("Cancelled by user");

        if (
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          try {
            await resolveStaleApprovals(runtime, socket, abortSignal);
            continue;
          } catch (_recoveryError) {
            if (abortSignal.aborted) throw new Error("Cancelled by user");
          }
        }

        const detail = await fetchRunErrorDetail(runtime.activeRunId);
        throw new Error(
          detail ||
            `Pre-stream approval conflict after ${preStreamRecoveryAttempts} recovery attempts`,
        );
      }

      if (action === "retry_transient") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
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
        transientRetries = attempt;

        const retryMessage = getRetryStatusMessage(errorDetail);
        if (retryMessage) {
          emitRetryDelta(socket, runtime, {
            message: retryMessage,
            reason: "error",
            attempt,
            maxAttempts: LLM_API_ERROR_MAX_RETRIES,
            delayMs,
            agentId: runtime.agentId ?? undefined,
            conversationId,
          });
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      if (action === "retry_conversation_busy") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        try {
          const client = await getClient();
          const discoveredRunId = await discoverFallbackRunIdWithTimeout(
            client,
            {
              conversationId,
              resolvedConversationId: conversationId,
              agentId: runtime.agentId ?? null,
              requestStartedAtMs,
            },
          );

          if (discoveredRunId) {
            if (abortSignal?.aborted) {
              throw new Error("Cancelled by user");
            }
            return await client.runs.messages.stream(discoveredRunId, {
              starting_after: 0,
              batch_size: 1000,
            });
          }
        } catch (resumeError) {
          if (abortSignal?.aborted) {
            throw new Error("Cancelled by user");
          }
          if (process.env.DEBUG) {
            console.warn(
              "[Listen] Pre-stream resume failed, falling back to wait/retry:",
              resumeError instanceof Error
                ? resumeError.message
                : String(resumeError),
            );
          }
        }

        const attempt = conversationBusyRetries + 1;
        const delayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt,
        });
        conversationBusyRetries = attempt;

        emitRetryDelta(socket, runtime, {
          message: "Conversation is busy, waiting and retrying…",
          reason: "error",
          attempt,
          maxAttempts: MAX_CONVERSATION_BUSY_RETRIES,
          delayMs,
          agentId: runtime.agentId ?? undefined,
          conversationId,
        });

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      throw preStreamError;
    }
  }
}

export async function sendApprovalContinuationWithRetry(
  conversationId: string,
  messages: Parameters<typeof sendMessageStream>[1],
  opts: Parameters<typeof sendMessageStream>[2],
  socket: WebSocket,
  runtime: ConversationRuntime,
  abortSignal?: AbortSignal,
  retryOptions: {
    allowApprovalRecovery?: boolean;
  } = {},
): Promise<Awaited<ReturnType<typeof sendMessageStream>> | null> {
  const allowApprovalRecovery = retryOptions.allowApprovalRecovery ?? true;
  let transientRetries = 0;
  let conversationBusyRetries = 0;
  let preStreamRecoveryAttempts = 0;
  const MAX_CONVERSATION_BUSY_RETRIES = 3;
  const requestStartedAtMs = Date.now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error("Cancelled by user");
    }
    runtime.isRecoveringApprovals = false;
    setLoopStatus(runtime, "WAITING_FOR_API_RESPONSE", {
      agent_id: runtime.agentId,
      conversation_id: conversationId,
    });

    try {
      return await sendMessageStream(
        conversationId,
        messages,
        opts,
        abortSignal
          ? { maxRetries: 0, signal: abortSignal }
          : { maxRetries: 0 },
      );
    } catch (preStreamError) {
      if (abortSignal?.aborted) {
        throw new Error("Cancelled by user");
      }

      const errorDetail = extractConflictDetail(preStreamError);
      const action = getPreStreamErrorAction(
        errorDetail,
        conversationBusyRetries,
        MAX_CONVERSATION_BUSY_RETRIES,
        {
          status:
            preStreamError instanceof APIError
              ? preStreamError.status
              : undefined,
          transientRetries,
          maxTransientRetries: LLM_API_ERROR_MAX_RETRIES,
        },
      );

      const approvalConflictDetected =
        action === "resolve_approval_pending" ||
        isApprovalToolCallDesyncError(errorDetail);

      if (approvalConflictDetected) {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });

        if (
          allowApprovalRecovery &&
          abortSignal &&
          preStreamRecoveryAttempts < MAX_PRE_STREAM_RECOVERY
        ) {
          preStreamRecoveryAttempts++;
          const drainResult = await resolveStaleApprovals(
            runtime,
            socket,
            abortSignal,
          );
          if (
            drainResult &&
            getApprovalContinuationRecoveryDisposition(drainResult) ===
              "handled"
          ) {
            finalizeHandledRecoveryTurn(runtime, socket, {
              drainResult,
              agentId: runtime.agentId ?? undefined,
              conversationId,
            });
            return null;
          }
          continue;
        }

        const detail = await fetchRunErrorDetail(runtime.activeRunId);
        throw new Error(
          detail ||
            `Approval continuation conflict after ${preStreamRecoveryAttempts} recovery attempts`,
        );
      }

      if (action === "retry_transient") {
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });
        const attempt = transientRetries + 1;
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
        transientRetries = attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      if (action === "retry_conversation_busy") {
        conversationBusyRetries += 1;
        runtime.isRecoveringApprovals = true;
        setLoopStatus(runtime, "RETRYING_API_REQUEST", {
          agent_id: runtime.agentId,
          conversation_id: conversationId,
        });

        try {
          const client = await getClient();
          const discoveredRunId = await discoverFallbackRunIdWithTimeout(
            client,
            {
              conversationId,
              resolvedConversationId: conversationId,
              agentId: runtime.agentId ?? null,
              requestStartedAtMs,
            },
          );

          if (discoveredRunId) {
            if (abortSignal?.aborted) {
              throw new Error("Cancelled by user");
            }
            return await client.runs.messages.stream(discoveredRunId, {
              starting_after: 0,
              batch_size: 1000,
            });
          }
        } catch (resumeError) {
          if (abortSignal?.aborted) {
            throw new Error("Cancelled by user");
          }
          if (process.env.DEBUG) {
            console.warn(
              "[Listen] Approval continuation pre-stream resume failed, falling back to wait/retry:",
              resumeError instanceof Error
                ? resumeError.message
                : String(resumeError),
            );
          }
        }

        const retryDelayMs = getRetryDelayMs({
          category: "conversation_busy",
          attempt: conversationBusyRetries,
        });
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        if (abortSignal?.aborted) {
          throw new Error("Cancelled by user");
        }
        continue;
      }

      throw preStreamError;
    }
  }
}
