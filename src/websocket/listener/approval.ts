import WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
import { getChannelRegistry } from "../../channels/registry";
import type {
  ApprovalResponseBody,
  ControlRequest,
} from "../../types/protocol_v2";
import {
  emitDeviceStatusIfOpen,
  emitLoopStatusIfOpen,
  setLoopStatus,
} from "./protocol-outbound";
import { evictConversationRuntimeIfIdle } from "./runtime";
import type { ConversationRuntime } from "./types";

async function dispatchChannelApprovalEvent(
  runtime: ConversationRuntime,
  event: {
    type: "requested" | "resolved";
    controlRequest: ControlRequest;
    response?: ApprovalResponseBody;
  },
): Promise<void> {
  const sources =
    runtime.pendingApprovalSourcesByRequestId.get(
      event.controlRequest.request_id,
    ) ?? [];
  if (sources.length === 0) {
    return;
  }

  const registry = getChannelRegistry();
  if (!registry) {
    return;
  }

  if (event.type === "requested") {
    await registry.dispatchApprovalEvent({
      type: "requested",
      controlRequest: event.controlRequest,
      sources,
    });
    return;
  }

  if (!event.response) {
    return;
  }

  await registry.dispatchApprovalEvent({
    type: "resolved",
    controlRequest: event.controlRequest,
    sources,
    response: event.response,
  });
}

export function rememberPendingApprovalBatchIds(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
  batchId: string,
): void {
  for (const approval of pendingApprovals) {
    if (approval.toolCallId) {
      runtime.pendingApprovalBatchByToolCallId.set(
        approval.toolCallId,
        batchId,
      );
    }
  }
}

export function resolvePendingApprovalBatchId(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  const batchIds = new Set<string>();
  for (const approval of pendingApprovals) {
    const batchId = runtime.pendingApprovalBatchByToolCallId.get(
      approval.toolCallId,
    );
    if (!batchId) {
      return null;
    }
    batchIds.add(batchId);
  }
  if (batchIds.size !== 1) {
    return null;
  }
  return batchIds.values().next().value ?? null;
}

export function resolveRecoveryBatchId(
  runtime: ConversationRuntime,
  pendingApprovals: Array<{ toolCallId: string }>,
): string | null {
  if (runtime.pendingApprovalBatchByToolCallId.size === 0) {
    return `recovery-${crypto.randomUUID()}`;
  }
  return resolvePendingApprovalBatchId(runtime, pendingApprovals);
}

export function clearPendingApprovalBatchIds(
  runtime: ConversationRuntime,
  approvals: Array<{ toolCallId: string }>,
): void {
  for (const approval of approvals) {
    runtime.pendingApprovalBatchByToolCallId.delete(approval.toolCallId);
  }
}

export function isValidApprovalResponseBody(
  value: unknown,
): value is ApprovalResponseBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeResponse = value as {
    request_id?: unknown;
    decision?: unknown;
    error?: unknown;
  };
  if (typeof maybeResponse.request_id !== "string") {
    return false;
  }
  if (maybeResponse.error !== undefined) {
    return typeof maybeResponse.error === "string";
  }
  if (!maybeResponse.decision || typeof maybeResponse.decision !== "object") {
    return false;
  }
  const decision = maybeResponse.decision as {
    behavior?: unknown;
    message?: unknown;
    updated_input?: unknown;
    selected_permission_suggestion_ids?: unknown;
  };
  if (decision.behavior === "allow") {
    const hasMessage =
      decision.message === undefined || typeof decision.message === "string";
    const hasUpdatedInput =
      decision.updated_input === undefined ||
      decision.updated_input === null ||
      typeof decision.updated_input === "object";
    const hasSelectedPermissionSuggestionIds =
      decision.selected_permission_suggestion_ids === undefined ||
      (Array.isArray(decision.selected_permission_suggestion_ids) &&
        decision.selected_permission_suggestion_ids.every(
          (entry) => typeof entry === "string",
        ));
    return hasMessage && hasUpdatedInput && hasSelectedPermissionSuggestionIds;
  }
  if (decision.behavior === "deny") {
    return typeof decision.message === "string";
  }
  return false;
}

export function collectApprovalResultToolCallIds(
  approvals: ApprovalResult[],
): string[] {
  return approvals
    .map((approval) => {
      if (
        approval &&
        typeof approval === "object" &&
        "tool_call_id" in approval &&
        typeof approval.tool_call_id === "string"
      ) {
        return approval.tool_call_id;
      }
      return null;
    })
    .filter((toolCallId): toolCallId is string => !!toolCallId);
}

export function collectDecisionToolCallIds(
  decisions: Array<{
    approval: {
      toolCallId: string;
    };
  }>,
): string[] {
  return decisions
    .map((decision) => decision.approval.toolCallId)
    .filter((toolCallId) => toolCallId.length > 0);
}

export function validateApprovalResultIds(
  decisions: Array<{
    approval: {
      toolCallId: string;
    };
  }>,
  approvals: ApprovalResult[],
): void {
  if (!process.env.DEBUG) {
    return;
  }

  const expectedIds = new Set(collectDecisionToolCallIds(decisions));
  const sendingIds = new Set(collectApprovalResultToolCallIds(approvals));
  const setsEqual =
    expectedIds.size === sendingIds.size &&
    [...expectedIds].every((toolCallId) => sendingIds.has(toolCallId));

  if (setsEqual) {
    return;
  }

  console.error(
    "[Listen][DEBUG] Approval ID mismatch detected",
    JSON.stringify(
      {
        expected: [...expectedIds],
        sending: [...sendingIds],
      },
      null,
      2,
    ),
  );
  throw new Error("Approval ID mismatch - refusing to send mismatched IDs");
}

export function resolvePendingApprovalResolver(
  runtime: ConversationRuntime,
  response: ApprovalResponseBody,
): boolean {
  const requestId = response.request_id;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return false;
  }

  const pending = runtime.pendingApprovalResolvers.get(requestId);
  if (!pending) {
    return false;
  }

  if (pending.controlRequest) {
    void dispatchChannelApprovalEvent(runtime, {
      type: "resolved",
      controlRequest: pending.controlRequest,
      response,
    }).catch((error) => {
      console.error(
        "[Channels] Failed to dispatch resolved approval event:",
        error instanceof Error ? error.message : error,
      );
    });
  }

  runtime.pendingApprovalResolvers.delete(requestId);
  runtime.pendingApprovalSourcesByRequestId.delete(requestId);
  runtime.listener.approvalRuntimeKeyByRequestId.delete(requestId);
  if (runtime.pendingApprovalResolvers.size === 0 && !runtime.isProcessing) {
    setLoopStatus(runtime, "WAITING_ON_INPUT");
  }
  pending.resolve(response);
  emitLoopStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  emitDeviceStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  evictConversationRuntimeIfIdle(runtime);
  return true;
}

export function rejectPendingApprovalResolvers(
  runtime: ConversationRuntime,
  reason: string,
): void {
  for (const [requestId, pending] of runtime.pendingApprovalResolvers) {
    if (pending.controlRequest) {
      void dispatchChannelApprovalEvent(runtime, {
        type: "resolved",
        controlRequest: pending.controlRequest,
        response: {
          request_id: requestId,
          error: reason,
        },
      }).catch((error) => {
        console.error(
          "[Channels] Failed to dispatch rejected approval event:",
          error instanceof Error ? error.message : error,
        );
      });
    }
    pending.reject(new Error(reason));
  }
  runtime.pendingApprovalResolvers.clear();
  runtime.pendingApprovalSourcesByRequestId.clear();
  for (const [requestId, runtimeKey] of runtime.listener
    .approvalRuntimeKeyByRequestId) {
    if (runtimeKey === runtime.key) {
      runtime.listener.approvalRuntimeKeyByRequestId.delete(requestId);
    }
  }
  setLoopStatus(runtime, "WAITING_ON_INPUT");
  emitLoopStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  emitDeviceStatusIfOpen(runtime.listener, {
    agent_id: runtime.agentId,
    conversation_id: runtime.conversationId,
  });
  evictConversationRuntimeIfIdle(runtime);
}

export function requestApprovalOverWS(
  runtime: ConversationRuntime,
  socket: WebSocket,
  requestId: string,
  controlRequest: ControlRequest,
): Promise<ApprovalResponseBody> {
  if (socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket not open"));
  }

  const abortSignal = runtime.activeAbortController?.signal ?? null;
  const isInterrupted = () =>
    runtime.cancelRequested || abortSignal?.aborted === true;

  if (isInterrupted()) {
    return Promise.reject(new Error("Cancelled by user"));
  }

  return new Promise<ApprovalResponseBody>((resolve, reject) => {
    let settled = false;
    const cleanupAbortListener = () => {
      abortSignal?.removeEventListener("abort", handleAbort);
    };
    const wrappedResolve = (response: ApprovalResponseBody) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbortListener();
      resolve(response);
    };
    const wrappedReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupAbortListener();
      reject(error);
    };
    const handleAbort = () => {
      if (controlRequest) {
        void dispatchChannelApprovalEvent(runtime, {
          type: "resolved",
          controlRequest,
          response: {
            request_id: requestId,
            error: "Cancelled by user",
          },
        }).catch((error) => {
          console.error(
            "[Channels] Failed to dispatch aborted approval event:",
            error instanceof Error ? error.message : error,
          );
        });
      }
      runtime.pendingApprovalResolvers.delete(requestId);
      runtime.pendingApprovalSourcesByRequestId.delete(requestId);
      runtime.listener.approvalRuntimeKeyByRequestId.delete(requestId);
      wrappedReject(new Error("Cancelled by user"));
    };

    abortSignal?.addEventListener("abort", handleAbort, { once: true });
    if (isInterrupted()) {
      handleAbort();
      return;
    }

    runtime.pendingApprovalResolvers.set(requestId, {
      resolve: wrappedResolve,
      reject: wrappedReject,
      controlRequest,
    });
    const channelTurnSources = runtime.activeChannelTurnSources ?? [];
    if (channelTurnSources.length > 0) {
      runtime.pendingApprovalSourcesByRequestId.set(requestId, [
        ...channelTurnSources,
      ]);
      void dispatchChannelApprovalEvent(runtime, {
        type: "requested",
        controlRequest,
      }).catch((error) => {
        console.error(
          "[Channels] Failed to dispatch requested approval event:",
          error instanceof Error ? error.message : error,
        );
      });
    }
    runtime.listener.approvalRuntimeKeyByRequestId.set(requestId, runtime.key);
    if (isInterrupted()) {
      handleAbort();
      return;
    }
    runtime.lastStopReason = "requires_approval";
    setLoopStatus(runtime, "WAITING_ON_APPROVAL");
    emitLoopStatusIfOpen(runtime.listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
    emitDeviceStatusIfOpen(runtime.listener, {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    });
  });
}

export function parseApprovalInput(toolArgs: string): Record<string, unknown> {
  if (!toolArgs) return {};
  try {
    const parsed = JSON.parse(toolArgs) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
