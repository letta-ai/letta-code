import WebSocket from "ws";
import type { ApprovalResult } from "../../agent/approval-execution";
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

  runtime.pendingApprovalResolvers.delete(requestId);
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
  for (const [, pending] of runtime.pendingApprovalResolvers) {
    pending.reject(new Error(reason));
  }
  runtime.pendingApprovalResolvers.clear();
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

  return new Promise<ApprovalResponseBody>((resolve, reject) => {
    runtime.pendingApprovalResolvers.set(requestId, {
      resolve,
      reject,
      controlRequest,
    });
    runtime.listener.approvalRuntimeKeyByRequestId.set(requestId, runtime.key);
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
