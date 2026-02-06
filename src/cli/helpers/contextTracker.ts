// Tracks context-window token usage across turns, decoupled from streaming buffers.

export const MAX_CONTEXT_HISTORY = 1000;

export type ContextTracker = {
  /** Most recent context_tokens from usage_statistics */
  lastContextTokens: number;
  /** History of context_tokens values for time-series display */
  contextTokensHistory: Array<{
    timestamp: number;
    tokens: number;
    turnId: number;
    compacted?: boolean;
  }>;
  /** Counter incremented once per user turn (before each stream drain) */
  currentTurnId: number;
  /** Set when a compaction event is seen; consumed by the next usage_statistics push */
  pendingCompaction: boolean;
};

export function createContextTracker(): ContextTracker {
  return {
    lastContextTokens: 0,
    contextTokensHistory: [],
    currentTurnId: 0, // simple in-memory counter for now
    pendingCompaction: false,
  };
}

/** Reset token tracking (e.g. on agent/conversation switch). currentTurnId is monotonic. */
export function resetContextHistory(ct: ContextTracker): void {
  ct.lastContextTokens = 0;
  ct.contextTokensHistory = [];
}
