import type { PendingControlRequest } from "../../types/protocol_v2";
import { resolveScopedAgentId, resolveScopedConversationId } from "./scope";
import type { ListenerRuntime, RecoveredApprovalState } from "./types";

let activeRuntime: ListenerRuntime | null = null;

export function getActiveRuntime(): ListenerRuntime | null {
  return activeRuntime;
}

export function setActiveRuntime(runtime: ListenerRuntime | null): void {
  activeRuntime = runtime;
}

export function safeEmitWsEvent(
  direction: "send" | "recv",
  label: "client" | "protocol" | "control" | "lifecycle",
  event: unknown,
): void {
  try {
    activeRuntime?.onWsEvent?.(direction, label, event);
  } catch {
    // Debug hook must never break transport flow.
  }
}

export function nextEventSeq(runtime: ListenerRuntime | null): number | null {
  if (!runtime) {
    return null;
  }
  runtime.eventSeqCounter += 1;
  return runtime.eventSeqCounter;
}

export function clearRuntimeTimers(runtime: ListenerRuntime): void {
  if (runtime.reconnectTimeout) {
    clearTimeout(runtime.reconnectTimeout);
    runtime.reconnectTimeout = null;
  }
  if (runtime.heartbeatInterval) {
    clearInterval(runtime.heartbeatInterval);
    runtime.heartbeatInterval = null;
  }
}

export function clearActiveRunState(runtime: ListenerRuntime): void {
  runtime.activeAgentId = null;
  runtime.activeConversationId = null;
  runtime.activeWorkingDirectory = null;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;
  runtime.activeAbortController = null;
}

export function clearRecoveredApprovalState(runtime: ListenerRuntime): void {
  runtime.recoveredApprovalState = null;
}

export function getRecoveredApprovalStateForScope(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): RecoveredApprovalState | null {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  if (!scopedAgentId) {
    return null;
  }
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const recovered = runtime.recoveredApprovalState;
  if (!recovered) {
    return null;
  }
  return recovered.agentId === scopedAgentId &&
    recovered.conversationId === scopedConversationId
    ? recovered
    : null;
}

export function clearRecoveredApprovalStateForScope(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): void {
  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  if (recovered) {
    clearRecoveredApprovalState(runtime);
  }
}

export function getPendingControlRequests(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): PendingControlRequest[] {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const requests: PendingControlRequest[] = [];

  for (const pending of runtime.pendingApprovalResolvers.values()) {
    const request = pending.controlRequest;
    if (!request) continue;
    if (
      scopedAgentId &&
      (request.agent_id ?? scopedAgentId) !== scopedAgentId
    ) {
      continue;
    }
    if (
      scopedConversationId &&
      (request.conversation_id ?? scopedConversationId) !== scopedConversationId
    ) {
      continue;
    }
    requests.push({
      request_id: request.request_id,
      request: request.request,
    });
  }

  const recovered = getRecoveredApprovalStateForScope(runtime, params);
  if (recovered) {
    for (const requestId of recovered.pendingRequestIds) {
      const entry = recovered.approvalsByRequestId.get(requestId);
      if (!entry) continue;
      requests.push({
        request_id: entry.controlRequest.request_id,
        request: entry.controlRequest.request,
      });
    }
  }

  return requests;
}

export function getPendingControlRequestCount(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): number {
  return getPendingControlRequests(runtime, params).length;
}
