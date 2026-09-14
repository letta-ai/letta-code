import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";

/** Conversation identity fields supported by the API before the next SDK release. */
export type ConversationWithIdentity = Omit<Conversation, "agent_id"> & {
  agent_id: string | null;
  created_by_agent_id?: string | null;
  name?: string | null;
  is_subagent?: boolean;
};

/** Ephemeral children execute with their creating agent's permissions. */
export function getConversationExecutionAgentId(
  conversation: Pick<
    ConversationWithIdentity,
    "agent_id" | "created_by_agent_id"
  >,
): string | null {
  return conversation.agent_id ?? conversation.created_by_agent_id ?? null;
}

export async function retrieveConversationAgent(
  conversationId: string,
  backend: Pick<
    import("./backend").Backend,
    "retrieveConversation" | "retrieveAgent"
  >,
  expectedAgentId?: string,
) {
  const conversation: ConversationWithIdentity =
    await backend.retrieveConversation(conversationId);
  const agentId = getConversationExecutionAgentId(conversation);
  if (!agentId)
    throw new Error("This conversation has no creating agent to inherit from.");
  if (expectedAgentId && agentId !== expectedAgentId)
    throw new Error("The conversation does not belong to the requested agent.");
  const agent = await backend.retrieveAgent(agentId, {
    include: ["agent.tools", "agent.tags"],
  });
  return { ...agent, name: conversation.name ?? agent.name };
}
