import { apiRequest } from "./request";

export interface ForkConversationOptions {
  agentId?: string;
  hidden?: boolean;
  useQuery?: boolean;
}

export async function forkConversation(
  conversationId: string,
  options: ForkConversationOptions = {},
): Promise<{ id: string }> {
  const payload = {
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
  };

  return apiRequest<{ id: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    options.useQuery ? undefined : payload,
    options.useQuery ? { query: payload } : {},
  );
}
