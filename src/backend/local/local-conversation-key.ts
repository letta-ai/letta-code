export function localConversationKey(
  conversationId: string,
  agentId: string,
): string {
  return conversationId === "default"
    ? `default:${agentId}`
    : `conversation:${conversationId}`;
}
