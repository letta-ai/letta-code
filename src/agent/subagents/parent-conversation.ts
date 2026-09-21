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
      /^parent-conversation:(agent-[^/\s]+)\/((?:local-)?conv-[^/\s]+|default)$/.exec(
        tag,
      );
    if (!match) continue;
    const [, agentId, conversationId] = match;
    if (agentId && conversationId)
      scopes.set(`${agentId}/${conversationId}`, { agentId, conversationId });
  }
  return [...scopes.values()];
}

export function getParentConversationTag(
  agentId?: string | null,
  conversationId?: string | null,
): string | undefined {
  if (!agentId || !conversationId) return undefined;
  const tag = `parent-conversation:${agentId}/${conversationId}`;
  return getParentConversationScopes([tag]).length ? tag : undefined;
}
