import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { setConversationMemoryReadOnly } from "@/runtime-context";

/** Conversation identity fields supported by the API before the next SDK release. */
export type ConversationWithIdentity = Omit<Conversation, "agent_id"> & {
  agent_id: string | null;
  parent_agent_id?: string | null;
  name?: string | null;
  is_subagent?: boolean;
};

/** Agent-free conversations execute with their explicitly inherited permissions. */
export function getConversationExecutionAgentId(
  conversation: Pick<ConversationWithIdentity, "agent_id" | "parent_agent_id">,
): string | null {
  return conversation.agent_id ?? conversation.parent_agent_id ?? null;
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
    throw new Error(
      "This conversation does not inherit an agent's permissions.",
    );
  if (expectedAgentId && agentId !== expectedAgentId)
    throw new Error("The conversation does not belong to the requested agent.");
  setConversationMemoryReadOnly(conversationId, conversation.agent_id === null);
  const agent = await backend.retrieveAgent(agentId, {
    include: ["agent.tools", "agent.tags"],
  });
  return { ...agent, name: conversation.name ?? agent.name };
}
