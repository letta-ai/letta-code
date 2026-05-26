import { apiRequest } from "./request";

export interface ForkConversationOptions {
  agentId?: string;
  hidden?: boolean;
}

export type InternalConversationDescriptionUpdateBody = Record<
  string,
  unknown
> & {
  description: string | null;
};

export async function forkConversation(
  conversationId: string,
  options: ForkConversationOptions = {},
): Promise<{ id: string }> {
  const query = {
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
  };

  return apiRequest<{ id: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    undefined,
    { query },
  );
}

export async function updateInternalConversationDescription(
  conversationId: string,
  body: InternalConversationDescriptionUpdateBody,
): Promise<string | null> {
  return apiRequest<string | null>(
    "POST",
    `/v1/_internal_conversations/${encodeURIComponent(conversationId)}/description`,
    body,
  );
}
