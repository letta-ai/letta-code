/**
 * Pure startup agent resolution logic.
 *
 * Encodes the decision tree for which agent to use when `letta` starts:
 *   local LRU → global LRU → selector → create default
 *
 * Extracted from index.ts/headless.ts so it can be unit-tested without
 * React effects or real network calls.
 */

export type StartupTarget =
  | { action: "resume"; agentId: string; conversationId?: string }
  | { action: "select" }
  | { action: "create" };

export interface StartupResolutionInput {
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

  /** --new-agent flag: skip all resume logic, create fresh */
  forceNew: boolean;

  /** Self-hosted server with no available default model */
  needsModelPicker: boolean;
}

/**
 * Determine which agent to start with based on available context.
 *
 * Decision tree:
 * 1. forceNew → create
 * 2. local LRU valid → resume (with local conversation)
 * 3. global LRU valid → resume (no conversation — project-scoped)
 * 4. needsModelPicker → select
 * 5. pinned agents exist → select
 * 6. nothing → create
 */
export function resolveStartupTarget(
  input: StartupResolutionInput,
): StartupTarget {
  // --new-agent always creates
  if (input.forceNew) {
    return { action: "create" };
  }

  // Step 1: Local project LRU
  if (input.localAgentId && input.localAgentExists) {
    return {
      action: "resume",
      agentId: input.localAgentId,
      conversationId: input.localConversationId ?? undefined,
    };
  }

  // Step 2: Global LRU (directory-switching fallback)
  // Do NOT restore global conversation — keep conversations project-scoped
  if (input.globalAgentId && input.globalAgentExists) {
    return {
      action: "resume",
      agentId: input.globalAgentId,
    };
  }

  // Step 3: Self-hosted model picker
  if (input.needsModelPicker) {
    return { action: "select" };
  }

  // Step 4: Show selector if any pinned agents exist
  if (input.mergedPinnedCount > 0) {
    return { action: "select" };
  }

  // Step 5: True fresh user — create default agent
  return { action: "create" };
}
