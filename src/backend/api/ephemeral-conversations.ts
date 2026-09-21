import { getClient } from "./client";
import { apiRequest } from "./request";

/** The conversation endpoint owns agent-free assistant-message projection. */
export async function listEphemeralReplies(
  conversationId: string,
  signal?: AbortSignal,
) {
  const client = await getClient();
  const query = {
    limit: 100,
    order: "desc",
    include_return_message_types: ["assistant_message" as const],
  };
  const page = await client.conversations.messages.list(conversationId, query, {
    signal,
  });
  return page.getPaginatedItems();
}

export interface EphemeralConversationCreateBody {
  [key: string]: unknown;
  model: string;
  system: string;
  parent_agent_id?: string;
  model_settings?: Record<string, unknown>;
  context_window_limit?: number | null;
}

export interface EphemeralConversation {
  id: string;
  agent_id: null;
  model: string;
  context_window_limit: number | null;
  model_settings?: Record<string, unknown> | null;
  name?: string | null;
  parent_agent_id?: string | null;
  is_subagent?: boolean;
}

export interface EphemeralConversationMetadata {
  name?: string;
  is_subagent?: boolean;
}

export async function createEphemeralConversation(
  body: EphemeralConversationCreateBody,
  metadata: EphemeralConversationMetadata = {},
  options?: { headers?: Record<string, string> },
): Promise<EphemeralConversation> {
  return apiRequest<EphemeralConversation>(
    "POST",
    "/v1/conversations/ephemeral",
    { ...body, ...metadata },
    options,
  );
}
