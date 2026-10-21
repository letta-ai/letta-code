/**
 * Scope matching shared by the interrupt paths and the stop-failure
 * notification selector, so a notification's "Press Esc to retry" hint is
 * only ever written for rows an Esc can actually reach: agent matching is
 * exact (a row with no recorded parent does not match a specific agent),
 * while an unscoped conversation matches every conversation.
 */
export interface SubagentScope {
  agentId?: string;
  conversationId?: string;
}

export function subagentScopeMatches(
  parentAgentId: string | undefined,
  parentConversationId: string | undefined,
  scope: SubagentScope,
): boolean {
  if (scope.agentId !== undefined && parentAgentId !== scope.agentId) {
    return false;
  }
  if (scope.conversationId === undefined) return true;
  return (
    parentConversationId === undefined ||
    parentConversationId === scope.conversationId
  );
}
