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
