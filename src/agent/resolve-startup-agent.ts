/**
 * Pure startup agent resolution logic.
 *
 * Encodes the decision tree for which agent to use when `letta` starts:
 *   pinned → local LRU → global LRU → selector → create default
 *
 * Extracted from index.ts/headless.ts so it can be unit-tested without
 * React effects or real network calls.
 */

export type StartupTarget =
  | { action: "resume"; agentId: string; conversationId?: string }
  | { action: "select" }
  | { action: "create" };

export interface StartupResolutionInput {
  /** The pinned agent to resume when exactly one pin exists for the active org */
  pinnedAgentId: string | null;
  /** Whether the pinned agent still exists on the server */
  pinnedAgentExists: boolean;
  /** Number of pinned agents configured for the active backend, including stale
   * or cross-org pins that no longer resolve (drives the selector fallback) */
  pinnedCount: number;
  /** Number of pinned agents that actually exist in the active org (drives the
   * single-resume and multi-pin select decisions) */
  existingPinnedCount: number;

  /** Agent ID from local project LRU (via getLocalLastAgentId) */
  localAgentId: string | null;
  /** Conversation ID from local project LRU */
  localConversationId: string | null;
  /** Whether the local agent still exists on the server */
  localAgentExists: boolean;

  /** Agent ID from global LRU (via getGlobalLastAgentId) */
  globalAgentId: string | null;
  /** Whether the global agent still exists on the server */
  globalAgentExists: boolean;

  /** Backend-store fallback when settings LRU entries are missing/stale */
  fallbackAgentId?: string | null;
  fallbackConversationId?: string | null;

  /** --new-agent flag: skip all resume logic, create fresh */
  forceNew: boolean;

  /** Custom API backend with no available default model */
  needsModelPicker: boolean;
}

/**
 * Determine which agent to start with based on available context.
 *
 * Decision tree:
 * 1. forceNew → create
 * 2. single existing pin → resume (with local conversation only if it matches LRU)
 * 3. multiple existing pins → select
 * 4. local LRU valid → resume (with local conversation)
 * 5. global LRU valid → resume (no conversation — project-scoped)
 * 6. backend-store fallback → resume
 * 7. needsModelPicker → select
 * 8. pins configured (even if stale) → select
 * 9. nothing → create
 */
export function resolveStartupTarget(
  input: StartupResolutionInput,
): StartupTarget {
  // --new-agent always creates
  if (input.forceNew) {
    return { action: "create" };
  }

  // Step 1: Pinned agent
  if (input.pinnedAgentId && input.pinnedAgentExists) {
    const conversationId =
      input.pinnedAgentId === input.localAgentId
        ? (input.localConversationId ?? undefined)
        : undefined;
    return {
      action: "resume",
      agentId: input.pinnedAgentId,
      ...(conversationId ? { conversationId } : {}),
    };
  }

  // Step 2: Multiple existing pins should ask instead of picking implicitly.
  // (Stale/cross-org pins are excluded — see existingPinnedCount.)
  if (input.existingPinnedCount > 1) {
    return { action: "select" };
  }

  // Step 3: Local project LRU
  if (input.localAgentId && input.localAgentExists) {
    return {
      action: "resume",
      agentId: input.localAgentId,
      conversationId: input.localConversationId ?? undefined,
    };
  }

  // Step 4: Global LRU (directory-switching fallback)
  // Do NOT restore global conversation — keep conversations project-scoped
  if (input.globalAgentId && input.globalAgentExists) {
    return {
      action: "resume",
      agentId: input.globalAgentId,
    };
  }

  if (input.fallbackAgentId) {
    return {
      action: "resume",
      agentId: input.fallbackAgentId,
      ...(input.fallbackConversationId
        ? { conversationId: input.fallbackConversationId }
        : {}),
    };
  }

  // Step 5: Custom API model picker
  if (input.needsModelPicker) {
    return { action: "select" };
  }

  // Step 6: Show selector if any pinned agents exist
  if (input.pinnedCount > 0) {
    return { action: "select" };
  }

  // Step 7: True fresh user — create default agent
  return { action: "create" };
}
