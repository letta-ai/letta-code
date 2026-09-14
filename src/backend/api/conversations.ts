import { apiRequest } from "./request";

export interface ForkConversationOptions {
  agentId?: string;
  hidden?: boolean;
  ephemeral?: boolean;
  name?: string;
  isSubagent?: boolean;
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
  request = apiRequest,
): Promise<{ id: string }> {
  const query = {
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    ...(options.hidden !== undefined ? { hidden: options.hidden } : {}),
    ...(options.messageId ? { message_id: options.messageId } : {}),
  };

  return request<{ id: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    options.ephemeral !== undefined ||
      options.name !== undefined ||
      options.isSubagent !== undefined
      ? {
          ...(options.ephemeral !== undefined
            ? { ephemeral: options.ephemeral }
            : {}),
          ...(options.name !== undefined ? { name: options.name } : {}),
          ...(options.isSubagent !== undefined
            ? { is_subagent: options.isSubagent }
            : {}),
        }
      : undefined,
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
