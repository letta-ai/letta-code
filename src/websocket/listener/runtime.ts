import { createContextTracker } from "../../cli/helpers/contextTracker";
import { createSharedReminderState } from "../../reminders/state";
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
  StartListenerOptions,
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

export function evictConversationRuntimeIfIdle(
  runtime: ConversationRuntime,
): boolean {
  if (
    runtime.isProcessing ||
    runtime.isRecoveringApprovals ||
    runtime.queuePumpActive ||
    runtime.queuePumpScheduled ||
    runtime.pendingTurns > 0 ||
    runtime.pendingApprovalResolvers.size > 0 ||
    runtime.pendingApprovalBatchByToolCallId.size > 0 ||
    runtime.recoveredApprovalState !== null ||
    runtime.pendingInterruptedResults !== null ||
    runtime.pendingInterruptedContext !== null ||
    runtime.activeExecutingToolCallIds.length > 0 ||
    (runtime.pendingInterruptedToolCallIds?.length ?? 0) > 0 ||
    runtime.activeRunId !== null ||
    runtime.activeRunStartedAt !== null ||
    runtime.activeAbortController !== null ||
    runtime.cancelRequested ||
    runtime.queuedMessagesByItemId.size > 0 ||
    runtime.queueRuntime?.length > 0
  ) {
    return false;
  }

  if (runtime.listener.conversationRuntimes.get(runtime.key) !== runtime) {
    return false;
  }

  runtime.listener.conversationRuntimes.delete(runtime.key);
  for (const [requestId, runtimeKey] of runtime.listener
    .approvalRuntimeKeyByRequestId) {
    if (runtimeKey === runtime.key) {
      runtime.listener.approvalRuntimeKeyByRequestId.delete(requestId);
    }
  }
  if (
    runtime.listener.pendingQueueEmitScope?.agent_id === runtime.agentId &&
    normalizeConversationId(
      runtime.listener.pendingQueueEmitScope?.conversation_id,
    ) === runtime.conversationId
  ) {
    runtime.listener.pendingQueueEmitScope = undefined;
  }
  return true;
}

export function getListenerStatus(
  listener: ListenerRuntime,
): "idle" | "receiving" | "processing" {
  let hasPendingTurns = false;
  for (const runtime of listener.conversationRuntimes.values()) {
    if (runtime.isProcessing || runtime.isRecoveringApprovals) {
      return "processing";
    }
    if (runtime.pendingTurns > 0) {
      hasPendingTurns = true;
    }
  }
  return hasPendingTurns ? "receiving" : "idle";
}

export function emitListenerStatus(
  listener: ListenerRuntime,
  onStatusChange: StartListenerOptions["onStatusChange"] | undefined,
  connectionId: string | undefined,
): void {
  if (!connectionId) {
    return;
  }
  const status = getListenerStatus(listener);
  if (listener.lastEmittedStatus === status) {
    return;
  }
  listener.lastEmittedStatus = status;
  onStatusChange?.(status, connectionId);
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
  const runtimeKey = getConversationRuntimeKey(
    normalizedAgentId,
    normalizedConversationId,
  );
  const conversationRuntime: ConversationRuntime = {
    listener,
    key: runtimeKey,
    agentId: normalizedAgentId,
    conversationId: normalizedConversationId,
    activeChannelTurnSources: null,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    lastStopReason: null,
    isProcessing: false,
    activeWorkingDirectory: null,
    expectedWorktreePath: null,
    expectedWorktreeExpiresAt: null,
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
    currentToolset: null,
    currentToolsetPreference: "auto",
    currentLoadedTools: [],
    pendingApprovalBatchByToolCallId: new Map(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
    activeExecutingToolCallIds: [],
    pendingInterruptedToolCallIds: null,
    reminderState:
      listener.reminderStateByConversation.get(runtimeKey) ??
      (() => {
        const state = createSharedReminderState();
        listener.reminderStateByConversation.set(runtimeKey, state);
        return state;
      })(),
    contextTracker:
      listener.contextTrackerByConversation.get(runtimeKey) ??
      (() => {
        const tracker = createContextTracker();
        listener.contextTrackerByConversation.set(runtimeKey, tracker);
        return tracker;
      })(),
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
  evictConversationRuntimeIfIdle(runtime);
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

export function hasInterruptedCacheForScope(
  runtime: ListenerRuntime,
  params?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
): boolean {
  const scopedAgentId = resolveScopedAgentId(runtime, params);
  const scopedConversationId = resolveScopedConversationId(runtime, params);
  const conversationRuntime = getConversationRuntime(
    runtime,
    scopedAgentId,
    scopedConversationId,
  );
  if (!conversationRuntime) {
    return false;
  }

  const context = conversationRuntime.pendingInterruptedContext;
  if (
    context &&
    context.agentId === (scopedAgentId ?? "") &&
    context.conversationId === scopedConversationId &&
    context.continuationEpoch === conversationRuntime.continuationEpoch
  ) {
    return true;
  }

  return false;
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
