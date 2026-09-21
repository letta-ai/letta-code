export interface ParentConversationScope {
  agentId: string;
  conversationId: string;
}

/** Stored child-owned links identify one exact parent scope per tag. */
export function getParentConversationScopes(
  tags: readonly string[],
): ParentConversationScope[] {
  const scopes = new Map<string, ParentConversationScope>();
  for (const tag of tags) {
    const match =
      /^parent-conversation:(agent-[^/\s]+)\/(conv-[^/\s]+|default)$/.exec(tag);
    if (!match) continue;
    const [, agentId, conversationId] = match;
    if (agentId && conversationId)
      scopes.set(`${agentId}/${conversationId}`, { agentId, conversationId });
  }
  return [...scopes.values()];
}
