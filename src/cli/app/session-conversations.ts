import type { LettaCodeSession } from "@letta-ai/letta-agent-sdk";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { Backend } from "@/backend";

export function sessionConversations(current: () => LettaCodeSession) {
  const listConversationMessages = async (
    conversationId: string,
    query?: Parameters<Backend["listConversationMessages"]>[1],
  ) => {
    const response = await current().sendCommand<{
      type: "conversation_messages_list_response";
      success: boolean;
      messages: Message[];
      error?: string;
    }>(
      {
        type: "conversation_messages_list",
        conversation_id: conversationId,
        query,
      },
      { responseType: "conversation_messages_list_response" },
    );
    if (!response.success)
      throw new Error(response.error ?? "Could not load messages");
    return response.messages;
  };
  return {
    listConversationMessages,
    listAgentMessages: (
      agentId: string,
      query?: Parameters<Backend["listAgentMessages"]>[1],
    ) => listConversationMessages("default", { ...query, agent_id: agentId }),
    async listConversations(
      query?: Parameters<Backend["listConversations"]>[0],
    ) {
      const response = await current().sendCommand<{
        type: "conversation_list_response";
        success: boolean;
        conversations: Conversation[];
        error?: string;
      }>(
        { type: "conversation_list", query },
        { responseType: "conversation_list_response" },
      );
      if (!response.success)
        throw new Error(response.error ?? "Could not load conversations");
      return response.conversations;
    },
  };
}
