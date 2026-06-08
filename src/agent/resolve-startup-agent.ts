/**
 * Pure startup agent resolution logic.
 *
 * Encodes the decision tree for which agent to use when `letta` starts:
 *   local pinned → local LRU → global LRU → selector → create default
 *
 * Extracted from index.ts/headless.ts so it can be unit-tested without
 * React effects or real network calls.
 */

export type StartupTarget =
  | { action: "resume"; agentId: string; conversationId?: string }
  | { action: "select" }
  | { action: "create" };

export interface StartupResolutionInput {
  /** Agent ID from local project pins (via getLocalPinnedAgents) */
  localPinnedAgentId: string | null;
  /** Whether the local pinned agent still exists on the server */
  localPinnedAgentExists: boolean;
  /** Number of local project pins for the active backend */
  localPinnedCount: number;

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

  /** Number of merged pinned agents (local + global) */
  mergedPinnedCount: number;

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
 * 2. local pinned valid → resume (with local conversation only if it matches LRU)
 * 3. multiple local pins → select
 * 4. local LRU valid → resume (with local conversation)
 * 5. global LRU valid → resume (no conversation — project-scoped)
 * 6. backend-store fallback → resume
 * 7. needsModelPicker → select
 * 8. pinned agents exist → select
 * 9. nothing → create
 */
export function resolveStartupTarget(
  input: StartupResolutionInput,
): StartupTarget {
  // --new-agent always creates
  if (input.forceNew) {
    return { action: "create" };
  }

  // Step 1: Local project pin
  if (input.localPinnedAgentId && input.localPinnedAgentExists) {
    const conversationId =
      input.localPinnedAgentId === input.localAgentId
        ? (input.localConversationId ?? undefined)
        : undefined;
    return {
      action: "resume",
      agentId: input.localPinnedAgentId,
      ...(conversationId ? { conversationId } : {}),
    };
  }

  // Step 2: Multiple local pins should ask instead of picking implicitly.
  if (input.localPinnedCount > 1) {
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
  if (input.mergedPinnedCount > 0) {
    return { action: "select" };
  }

  // Step 7: True fresh user — create default agent
  return { action: "create" };
}
