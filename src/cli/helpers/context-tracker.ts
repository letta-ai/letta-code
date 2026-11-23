export const MAX_CONTEXT_HISTORY = 1000;

export type ContextTracker = {
  lastContextTokens: number;
  contextTokensHistory: Array<{
    timestamp: number;
    tokens: number;
    turnId: number;
    compacted?: boolean;
  }>;
  currentTurnId: number;
  pendingCompaction: boolean;
  pendingReflectionTrigger: boolean;
  pendingConversationDescriptionRegeneration: boolean;
};

export function createContextTracker(): ContextTracker {
  return {
    lastContextTokens: 0,
    contextTokensHistory: [],
    currentTurnId: 0,
    pendingCompaction: false,
    pendingReflectionTrigger: false,
    pendingConversationDescriptionRegeneration: false,
  };
}

export function resetContextHistory(ct: ContextTracker): void {
  ct.lastContextTokens = 0;
  ct.contextTokensHistory = [];
  ct.pendingCompaction = false;
  ct.pendingReflectionTrigger = false;
  ct.pendingConversationDescriptionRegeneration = false;
}
