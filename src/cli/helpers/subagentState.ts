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
  totalTokens: number;
  durationMs: number;
  error?: string;
  model?: string;
  startTime: number;
  toolCallId?: string; // Links this subagent to its parent Task tool call
}

interface SubagentStore {
  agents: Map<string, SubagentState>;
  expanded: boolean;
  listeners: Set<() => void>;
}

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
    totalTokens: 0,
    durationMs: 0,
    startTime: Date.now(),
    toolCallId,
  };

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

  // Create a new object to ensure React.memo detects the change
  const updatedAgent = { ...agent, ...updates };
  store.agents.set(id, updatedAgent);
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
  } as SubagentState;
  store.agents.set(id, updatedAgent);
  notifyListeners();
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
  for (const [id, agent] of store.agents.entries()) {
    if (agent.status === "completed" || agent.status === "error") {
      store.agents.delete(id);
    }
  }
  notifyListeners();
}

/**
 * Clear specific subagents by their IDs (call when committing to staticItems)
 */
export function clearSubagentsByIds(ids: string[]): void {
  for (const id of ids) {
    store.agents.delete(id);
  }
  notifyListeners();
}

/**
 * Clear all subagents
 */
export function clearAllSubagents(): void {
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
