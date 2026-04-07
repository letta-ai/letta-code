/**
 * Subagent state management for tracking active subagents
 *
 * This module provides a centralized state store that bridges non-React code
 * (manager.ts) with React components (SubagentGroupDisplay.tsx).
 * Uses an event-emitter pattern compatible with React's useSyncExternalStore.
 */

// ============================================================================
// Types
// ============================================================================

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface SubagentState {
  id: string;
  type: string; // "Explore", "Plan", "code-reviewer", etc.
  description: string;
  status: "pending" | "running" | "completed" | "error";
  agentURL: string | null;
  toolCalls: ToolCall[];
  // Monotonic counter to avoid transient regressions in rendered tool usage.
  maxToolCallsSeen: number;
  totalTokens: number;
  durationMs: number;
  error?: string;
  model?: string;
  startTime: number;
  toolCallId?: string; // Links this subagent to its parent Task tool call
  isBackground?: boolean; // True if running in background (fire-and-forget)
  silent?: boolean; // True if this subagent should be hidden from SubagentGroupDisplay
  parentAgentId?: string; // Parent runtime scope agent id (for listener-mode WS scoping)
  parentConversationId?: string; // Parent runtime scope conversation id
}

interface SubagentStore {
  agents: Map<string, SubagentState>;
  expanded: boolean;
  listeners: Set<() => void>;
}

type TimerHandle = ReturnType<typeof setTimeout>;

// ============================================================================
// Store
// ============================================================================

const store: SubagentStore = {
  agents: new Map(),
  expanded: false,
  listeners: new Set(),
};

// Cached snapshot for useSyncExternalStore - must return same reference if unchanged
let cachedSnapshot: { agents: SubagentState[]; expanded: boolean } = {
  agents: [],
  expanded: false,
};

const DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS = 30_000;
let completedSubagentRetentionMs = DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS;
const completedSubagentCleanupTimers = new Map<string, TimerHandle>();

// ============================================================================
// Internal Helpers
// ============================================================================

function updateSnapshot(): void {
  cachedSnapshot = {
    agents: Array.from(store.agents.values()),
    expanded: store.expanded,
  };
}

function notifyListeners(): void {
  updateSnapshot();
  for (const listener of store.listeners) {
    listener();
  }
}

function clearCompletedSubagentCleanup(id: string): void {
  const existing = completedSubagentCleanupTimers.get(id);
  if (!existing) {
    return;
  }

  clearTimeout(existing);
  completedSubagentCleanupTimers.delete(id);
}

function unrefTimer(timer: TimerHandle): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

function scheduleCompletedSubagentCleanup(id: string): void {
  const agent = store.agents.get(id);
  if (!agent || (agent.status !== "completed" && agent.status !== "error")) {
    return;
  }

  clearCompletedSubagentCleanup(id);
  const timer = setTimeout(() => {
    const current = store.agents.get(id);
    if (
      !current ||
      (current.status !== "completed" && current.status !== "error")
    ) {
      completedSubagentCleanupTimers.delete(id);
      return;
    }

    store.agents.delete(id);
    completedSubagentCleanupTimers.delete(id);
    notifyListeners();
  }, completedSubagentRetentionMs);
  unrefTimer(timer);
  completedSubagentCleanupTimers.set(id, timer);
}

let subagentCounter = 0;

// ============================================================================
// Public API
// ============================================================================

/**
 * Generate a unique subagent ID
 */
export function generateSubagentId(): string {
  return `subagent-${Date.now()}-${++subagentCounter}`;
}

/**
 * Get a subagent by its parent Task tool call ID
 */
export function getSubagentByToolCallId(
  toolCallId: string,
): SubagentState | undefined {
  for (const agent of store.agents.values()) {
    if (agent.toolCallId === toolCallId) {
      return agent;
    }
  }
  return undefined;
}

/**
 * Register a new subagent when Task tool starts
 */
export function registerSubagent(
  id: string,
  type: string,
  description: string,
  toolCallId?: string,
  isBackground?: boolean,
  silent?: boolean,
  parentScope?: {
    agentId?: string | null;
    conversationId?: string | null;
  },
): void {
  // Capitalize type for display (explore -> Explore)
  const displayType = type.charAt(0).toUpperCase() + type.slice(1);

  const agent: SubagentState = {
    id,
    type: displayType,
    description,
    status: "pending",
    agentURL: null,
    toolCalls: [],
    maxToolCallsSeen: 0,
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now(),
    toolCallId,
    isBackground,
    silent,
    parentAgentId: parentScope?.agentId ?? undefined,
    parentConversationId:
      parentScope?.conversationId && parentScope.conversationId.length > 0
        ? parentScope.conversationId
        : undefined,
  };

  clearCompletedSubagentCleanup(id);
  store.agents.set(id, agent);
  notifyListeners();
}

/**
 * Update a subagent's state
 */
export function updateSubagent(
  id: string,
  updates: Partial<Omit<SubagentState, "id">>,
): void {
  const agent = store.agents.get(id);
  if (!agent) return;

  // If setting agentURL, also mark as running
  if (updates.agentURL && agent.status === "pending") {
    updates.status = "running";
  }

  const nextToolCalls = updates.toolCalls ?? agent.toolCalls;
  const nextMax = Math.max(
    agent.maxToolCallsSeen,
    nextToolCalls.length,
    updates.maxToolCallsSeen ?? 0,
  );

  // Skip no-op updates to avoid unnecessary re-renders
  const keys = Object.keys(updates) as (keyof typeof updates)[];
  const isNoop =
    keys.every((k) => agent[k] === updates[k]) &&
    nextMax === agent.maxToolCallsSeen;
  if (isNoop) return;

  // Create a new object to ensure React.memo detects the change
  const updatedAgent = { ...agent, ...updates, maxToolCallsSeen: nextMax };
  store.agents.set(id, updatedAgent);
  if (updatedAgent.status === "completed" || updatedAgent.status === "error") {
    scheduleCompletedSubagentCleanup(id);
  } else {
    clearCompletedSubagentCleanup(id);
  }
  notifyListeners();
}

/**
 * Add a tool call to a subagent
 */
export function addToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
): void {
  const agent = store.agents.get(subagentId);
  if (!agent) return;

  // Don't add duplicates
  if (agent.toolCalls.some((tc) => tc.id === toolCallId)) return;

  // Create a new object to ensure React.memo detects the change
  const updatedAgent = {
    ...agent,
    toolCalls: [
      ...agent.toolCalls,
      { id: toolCallId, name: toolName, args: toolArgs },
    ],
    maxToolCallsSeen: Math.max(
      agent.maxToolCallsSeen,
      agent.toolCalls.length + 1,
    ),
  };
  store.agents.set(subagentId, updatedAgent);
  notifyListeners();
}

/**
 * Mark a subagent as completed
 */
export function completeSubagent(
  id: string,
  result: { success: boolean; error?: string; totalTokens?: number },
): void {
  const agent = store.agents.get(id);
  if (!agent) return;

  // Create a new object to ensure React.memo detects the change
  const updatedAgent = {
    ...agent,
    status: result.success ? "completed" : "error",
    error: result.error,
    durationMs: Date.now() - agent.startTime,
    totalTokens: result.totalTokens ?? agent.totalTokens,
    maxToolCallsSeen: Math.max(agent.maxToolCallsSeen, agent.toolCalls.length),
  } as SubagentState;
  store.agents.set(id, updatedAgent);
  scheduleCompletedSubagentCleanup(id);
  notifyListeners();
}

export function __setCompletedSubagentRetentionMsForTests(ms: number): void {
  completedSubagentRetentionMs = ms;
}

export function __resetCompletedSubagentRetentionMsForTests(): void {
  completedSubagentRetentionMs = DEFAULT_COMPLETED_SUBAGENT_RETENTION_MS;
}

export function getSubagentToolCount(
  agent: Pick<SubagentState, "toolCalls" | "maxToolCallsSeen">,
): number {
  return Math.max(agent.toolCalls.length, agent.maxToolCallsSeen);
}

/**
 * Toggle expanded/collapsed state
 */
export function toggleExpanded(): void {
  store.expanded = !store.expanded;
  notifyListeners();
}

/**
 * Get current expanded state
 */
export function isExpanded(): boolean {
  return store.expanded;
}

/**
 * Get all active subagents (not yet cleared)
 */
export function getSubagents(): SubagentState[] {
  return Array.from(store.agents.values());
}

/**
 * Get silent background agents that are still pending or running
 */
export function getActiveBackgroundAgents(): SubagentState[] {
  return Array.from(store.agents.values()).filter(
    (a) =>
      a.silent === true && (a.status === "pending" || a.status === "running"),
  );
}

/**
 * Get subagents grouped by type
 */
export function getGroupedSubagents(): Map<string, SubagentState[]> {
  const grouped = new Map<string, SubagentState[]>();
  for (const agent of store.agents.values()) {
    const existing = grouped.get(agent.type) || [];
    existing.push(agent);
    grouped.set(agent.type, existing);
  }
  return grouped;
}

/**
 * Clear all completed subagents (call on new user message)
 */
export function clearCompletedSubagents(): void {
  let removedAny = false;
  for (const [id, agent] of store.agents.entries()) {
    if (agent.status === "completed" || agent.status === "error") {
      clearCompletedSubagentCleanup(id);
      store.agents.delete(id);
      removedAny = true;
    }
  }
  if (removedAny) {
    notifyListeners();
  }
}

/**
 * Clear specific subagents by their IDs (call when committing to staticItems)
 */
export function clearSubagentsByIds(ids: string[]): void {
  let removedAny = false;
  for (const id of ids) {
    clearCompletedSubagentCleanup(id);
    removedAny = store.agents.delete(id) || removedAny;
  }
  if (removedAny) {
    notifyListeners();
  }
}

/**
 * Clear all subagents
 */
export function clearAllSubagents(): void {
  for (const id of Array.from(completedSubagentCleanupTimers.keys())) {
    clearCompletedSubagentCleanup(id);
  }
  store.agents.clear();
  notifyListeners();
}

/**
 * Check if there are any active subagents
 */
export function hasActiveSubagents(): boolean {
  for (const agent of store.agents.values()) {
    if (agent.status === "pending" || agent.status === "running") {
      return true;
    }
  }
  return false;
}

/**
 * Mark all running/pending subagents as interrupted
 * Called when user presses ESC to interrupt execution
 */
export function interruptActiveSubagents(errorMessage: string): void {
  let anyInterrupted = false;
  for (const [id, agent] of store.agents.entries()) {
    if (agent.status === "pending" || agent.status === "running") {
      const updatedAgent: SubagentState = {
        ...agent,
        status: "error",
        error: errorMessage,
        durationMs: Date.now() - agent.startTime,
      };
      store.agents.set(id, updatedAgent);
      scheduleCompletedSubagentCleanup(id);
      anyInterrupted = true;
    }
  }
  if (anyInterrupted) {
    notifyListeners();
  }
}

// ============================================================================
// React Integration (useSyncExternalStore compatible)
// ============================================================================

/**
 * Subscribe to store changes
 */
export function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/**
 * Get a snapshot of the current state for React
 * Returns cached snapshot - only updates when notifyListeners is called
 */
export function getSnapshot(): {
  agents: SubagentState[];
  expanded: boolean;
} {
  return cachedSnapshot;
}

// ============================================================================
// Stream Event Forwarding
// ============================================================================

/**
 * A raw message-type event from the subagent's stdout (headless format).
 * Shape: { type: "message", message_type: string, ...LettaStreamingResponse fields }
 */
export interface SubagentStreamEvent {
  type: "message";
  message_type: string;
  [key: string]: unknown;
}

/**
 * Callback for forwarding raw subagent stream events to the WS layer.
 * The event is the parsed JSON line from the subagent's stdout.
 */
export type SubagentStreamEventListener = (
  subagentId: string,
  event: SubagentStreamEvent,
) => void;

const streamEventListeners = new Set<SubagentStreamEventListener>();

/**
 * Subscribe to raw subagent stream events (for WS forwarding).
 * Returns an unsubscribe function.
 */
export function subscribeToStreamEvents(
  listener: SubagentStreamEventListener,
): () => void {
  streamEventListeners.add(listener);
  return () => {
    streamEventListeners.delete(listener);
  };
}

/**
 * Emit a raw stream event from a subagent. Called from processStreamEvent
 * in manager.ts for message-type events that should be forwarded to the web UI.
 */
export function emitStreamEvent(
  subagentId: string,
  event: SubagentStreamEvent,
): void {
  for (const listener of streamEventListeners) {
    listener(subagentId, event);
  }
}
