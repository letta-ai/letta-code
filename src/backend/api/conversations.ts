import { ApiRequestError, apiRequest } from "./request";

export interface ForkConversationOptions {
  agentId?: string;
  hidden?: boolean;
  messageId?: string;
  /** Extra headers forwarded on the request (e.g. acting-user echo). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type ConversationDescriptionUpdateBody = Record<string, unknown> & {
  description: string | null;
};

export type SummarizeConversationBody = Record<string, unknown> & {
  prompt: string;
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  model?: string;
};

export async function forkConversation(
  conversationId: string,
  options: ForkConversationOptions = {},
): Promise<{ id: string }> {
  const query = {
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
    ...(options.messageId ? { message_id: options.messageId } : {}),
  };

  return apiRequest<{ id: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    undefined,
    {
      query,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

export async function updateConversationDescription(
  conversationId: string,
  body: ConversationDescriptionUpdateBody,
): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(
    "PATCH",
    `/v1/conversations/${encodeURIComponent(conversationId)}`,
    body,
  );
}

export async function summarizeConversation(
  conversationId: string,
  body: SummarizeConversationBody,
  options: { signal?: AbortSignal } = {},
): Promise<{ summary: string }> {
  return apiRequest<{ summary: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/summarize`,
    body,
    options,
  );
}

/**
 * GET /v1/conversations/:conversationId
 *
 * Returns the conversation (including its owning `agent_id`), or `null` when
 * the server reports that no conversation with this ID exists.
 */
export async function getConversation(
  conversationId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ id: string; agent_id: string } | null> {
  try {
    return await apiRequest<{ id: string; agent_id: string }>(
      "GET",
      `/v1/conversations/${encodeURIComponent(conversationId)}`,
      undefined,
      options,
    );
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return null;
    }
    throw error;
  }
}
