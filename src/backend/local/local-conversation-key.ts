/**
 * Identity key for a conversation owned by an agent. Every agent has its own
 * "default" conversation, so that id is only unique together with the agent.
 */
export function localConversationKey(
  conversationId: string,
  agentId: string,
): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}
