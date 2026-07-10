import { apiRequest } from "./request";

export interface ForkConversationOptions {
  agentId?: string;
  hidden?: boolean;
  /** Extra headers forwarded on the request (e.g. acting-user echo). */
  headers?: Record<string, string>;
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
  };

  return apiRequest<{ id: string }>(
    "POST",
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    undefined,
    { query, ...(options.headers ? { headers: options.headers } : {}) },
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
