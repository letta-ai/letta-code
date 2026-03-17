import type { PendingControlRequest } from "../../types/protocol_v2";
import {
  normalizeConversationId,
  normalizeCwdAgentId,
  resolveScopedAgentId,
  resolveScopedConversationId,
} from "./scope";
import type {
  ConversationRuntime,
  ListenerRuntime,
  RecoveredApprovalState,
} from "./types";

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

export function getConversationRuntimeKey(
  agentId?: string | null,
  conversationId?: string | null,
): string {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  return `agent:${normalizedAgentId ?? "__unknown__"}::conversation:${normalizedConversationId}`;
}

export function createConversationRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime {
  const normalizedAgentId = normalizeCwdAgentId(agentId);
  const normalizedConversationId = normalizeConversationId(conversationId);
  const conversationRuntime: ConversationRuntime = {
    listener,
    key: getConversationRuntimeKey(normalizedAgentId, normalizedConversationId),
    agentId: normalizedAgentId,
    conversationId: normalizedConversationId,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    lastStopReason: null,
    isProcessing: false,
    activeWorkingDirectory: null,
    activeRunId: null,
    activeRunStartedAt: null,
    activeAbortController: null,
    cancelRequested: false,
    queueRuntime: null as unknown as ConversationRuntime["queueRuntime"],
    queuedMessagesByItemId: new Map(),
    queuePumpActive: false,
    queuePumpScheduled: false,
    pendingTurns: 0,
    isRecoveringApprovals: false,
    loopStatus: "WAITING_ON_INPUT",
    pendingApprovalBatchByToolCallId: new Map(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
    activeExecutingToolCallIds: [],
    pendingInterruptedToolCallIds: null,
  };
  listener.conversationRuntimes.set(
    conversationRuntime.key,
    conversationRuntime,
  );
  return conversationRuntime;
}

export function getConversationRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime | null {
  return (
    listener.conversationRuntimes.get(
      getConversationRuntimeKey(agentId, conversationId),
    ) ?? null
  );
}

export function getOrCreateConversationRuntime(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): ConversationRuntime {
  return (
    getConversationRuntime(listener, agentId, conversationId) ??
    createConversationRuntime(listener, agentId, conversationId)
  );
}

export function clearActiveRunState(runtime: ConversationRuntime): void {
  runtime.activeWorkingDirectory = null;
  runtime.activeRunId = null;
  runtime.activeRunStartedAt = null;
  runtime.activeAbortController = null;
}

export function clearRecoveredApprovalState(
  runtime: ConversationRuntime,
): void {
  runtime.recoveredApprovalState = null;
}

export function clearConversationRuntimeState(
  runtime: ConversationRuntime,
): void {
  runtime.cancelRequested = true;
  if (
    runtime.activeAbortController &&
    !runtime.activeAbortController.signal.aborted
  ) {
    runtime.activeAbortController.abort();
  }
  runtime.pendingApprovalBatchByToolCallId.clear();
  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.activeExecutingToolCallIds = [];
  runtime.loopStatus = "WAITING_ON_INPUT";
  runtime.continuationEpoch += 1;
  runtime.pendingTurns = 0;
  runtime.queuePumpActive = false;
  runtime.queuePumpScheduled = false;
  clearActiveRunState(runtime);
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
  const conversationRuntime = getConversationRuntime(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  const recovered = conversationRuntime?.recoveredApprovalState;
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
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  if (!scopedAgentId) {
    return;
  }
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const conversationRuntime = getConversationRuntime(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  if (conversationRuntime?.recoveredApprovalState) {
    clearRecoveredApprovalState(conversationRuntime);
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
  const conversationRuntime = getConversationRuntime(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  const requests: PendingControlRequest[] = [];

  if (!conversationRuntime) {
    return requests;
  }

  for (const pending of conversationRuntime.pendingApprovalResolvers.values()) {
    const request = pending.controlRequest;
    if (!request) continue;
    requests.push({
      request_id: request.request_id,
      request: request.request,
    });
  }

  const recovered = conversationRuntime.recoveredApprovalState;
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
