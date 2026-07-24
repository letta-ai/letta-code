import { createContextTracker } from "@/cli/helpers/context-tracker";
import { createSharedReminderState } from "@/reminders/state";
import type { PendingControlRequest } from "@/types/protocol_v2";
import { getWorkingDirectoryScopeKey } from "./cwd";
import {
  normalizeConversationId,
  normalizeCwdAgentId,
  resolveScopedAgentId,
  resolveScopedConversationId,
} from "./scope";
import { releaseListenerTurnContext } from "./turn-context";
import { TurnLifecycle } from "./turn-lifecycle";
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

/**
 * How long an evicted conversation's worktree watcher may stay alive waiting
 * for the conversation to come back. Runtime eviction is routine (it fires
 * after every quiescent turn), and the watcher's job is to track worktree
 * changes for an attached client *between* turns — so it must survive
 * eviction, but not for the life of the process. Without this, one live
 * fs.watch loop accumulates per conversation ever touched (LET-10138).
 */
export const WORKTREE_WATCHER_IDLE_STOP_MS = 30 * 60 * 1000;

type WatcherIdleStop = {
  timer: ReturnType<typeof setTimeout>;
  /** Structural view of WorktreeWatcherState; a type import would cycle. */
  watcher: { abort: AbortController };
};

const watcherIdleStopsByListener = new WeakMap<
  ListenerRuntime,
  Map<string, WatcherIdleStop>
>();

function scheduleWorktreeWatcherIdleStop(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): void {
  const scopeKey = getWorkingDirectoryScopeKey(
    runtime.agentId,
    runtime.conversationId,
  );
  const watcher = listener.worktreeWatcherByConversation.get(scopeKey);
  if (!watcher) return;

  let stops = watcherIdleStopsByListener.get(listener);
  if (!stops) {
    stops = new Map();
    watcherIdleStopsByListener.set(listener, stops);
  }
  const existing = stops.get(scopeKey);
  if (existing) {
    if (existing.watcher === watcher) return;
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    fireWatcherIdleStop(listener, scopeKey, watcher);
  }, WORKTREE_WATCHER_IDLE_STOP_MS);
  (timer as { unref?: () => void }).unref?.();
  stops.set(scopeKey, { timer, watcher });
}

function fireWatcherIdleStop(
  listener: ListenerRuntime,
  scopeKey: string,
  watcher: WatcherIdleStop["watcher"],
): void {
  watcherIdleStopsByListener.get(listener)?.delete(scopeKey);
  // Only stop the watcher this timer was scheduled for; a CWD change may
  // have replaced it with a fresh one that is still in use.
  if (listener.worktreeWatcherByConversation.get(scopeKey) === watcher) {
    watcher.abort.abort();
    listener.worktreeWatcherByConversation.delete(scopeKey);
  }
}

export const __watcherIdleStopTestUtils = {
  /** Fire every pending idle stop immediately (tests cannot wait 30 minutes). */
  firePending(listener: ListenerRuntime): void {
    const stops = watcherIdleStopsByListener.get(listener);
    if (!stops) return;
    for (const [scopeKey, pending] of [...stops.entries()]) {
      clearTimeout(pending.timer);
      fireWatcherIdleStop(listener, scopeKey, pending.watcher);
    }
  },
  hasPending(listener: ListenerRuntime, scopeKey: string): boolean {
    return watcherIdleStopsByListener.get(listener)?.has(scopeKey) ?? false;
  },
};

/** The conversation is active again: keep its worktree watcher running. */
function cancelWorktreeWatcherIdleStop(
  listener: ListenerRuntime,
  agentId?: string | null,
  conversationId?: string | null,
): void {
  const stops = watcherIdleStopsByListener.get(listener);
  if (!stops) return;
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  const pending = stops.get(scopeKey);
  if (pending) {
    clearTimeout(pending.timer);
    stops.delete(scopeKey);
  }
}

export function evictConversationRuntimeIfIdle(
  runtime: ConversationRuntime,
): boolean {
  if (
    runtime.turnLifecycle.kind !== "idle" ||
    runtime.queuePumpActive ||
    runtime.queuePumpScheduled ||
    runtime.pendingTurns > 0 ||
    runtime.pendingApprovalResolvers.size > 0 ||
    runtime.pendingApprovalBatchByToolCallId.size > 0 ||
    runtime.recoveredApprovalState !== null ||
    runtime.pendingInterruptedResults !== null ||
    runtime.pendingInterruptedContext !== null ||
    (runtime.pendingInterruptedToolCallIds?.length ?? 0) > 0 ||
    runtime.queuedMessagesByItemId.size > 0 ||
    runtime.queueRuntime?.length > 0
  ) {
    return false;
  }

  if (runtime.listener.conversationRuntimes.get(runtime.key) !== runtime) {
    return false;
  }

  runtime.listener.conversationRuntimes.delete(runtime.key);
  scheduleWorktreeWatcherIdleStop(runtime.listener, runtime);
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
    if (runtime.isProcessing) {
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
  cancelWorktreeWatcherIdleStop(
    listener,
    normalizedAgentId,
    normalizedConversationId,
  );
  const turnLifecycle = new TurnLifecycle();
  const conversationRuntime: ConversationRuntime = {
    listener,
    key: runtimeKey,
    agentId: normalizedAgentId,
    conversationId: normalizedConversationId,
    skillSources: listener.skillSourcesByConversation.get(runtimeKey)?.slice(),
    activeChannelTurn: null,
    turnLifecycle,
    messageQueue: Promise.resolve(),
    pendingApprovalResolvers: new Map(),
    recoveredApprovalState: null,
    get lastStopReason() {
      return turnLifecycle.lastStopReason;
    },
    lastTerminalLoopErrorMessage: null,
    lastTerminalLoopErrorRunId: null,
    get isProcessing() {
      return turnLifecycle.isProcessing;
    },
    get activeWorkingDirectory() {
      return turnLifecycle.activeWorkingDirectory;
    },
    expectedWorktreePath: null,
    expectedWorktreeExpiresAt: null,
    get activeRunId() {
      return turnLifecycle.activeRunId;
    },
    get cancelRequested() {
      return turnLifecycle.cancelRequested;
    },
    queueRuntime: null as unknown as ConversationRuntime["queueRuntime"],
    queuedMessagesByItemId: new Map(),
    queuePumpActive: false,
    queuePumpScheduled: false,
    pendingTurns: 0,
    get loopStatus() {
      return turnLifecycle.loopStatus;
    },
    currentToolset: null,
    currentToolsetPreference: "auto",
    currentLoadedTools: [],
    pendingApprovalBatchByToolCallId: new Map(),
    pendingInterruptedResults: null,
    pendingInterruptedContext: null,
    continuationEpoch: 0,
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

export function clearRecoveredApprovalState(
  runtime: ConversationRuntime,
): void {
  runtime.recoveredApprovalState = null;
  evictConversationRuntimeIfIdle(runtime);
}

export function clearConversationRuntimeState(
  runtime: ConversationRuntime,
): void {
  runtime.turnLifecycle.reset("cancelled");
  releaseListenerTurnContext({
    runtime,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
  });
  runtime.pendingApprovalBatchByToolCallId.clear();
  runtime.pendingInterruptedResults = null;
  runtime.pendingInterruptedContext = null;
  runtime.pendingInterruptedToolCallIds = null;
  runtime.continuationEpoch += 1;
  runtime.pendingTurns = 0;
  runtime.queuePumpActive = false;
  runtime.queuePumpScheduled = false;
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
