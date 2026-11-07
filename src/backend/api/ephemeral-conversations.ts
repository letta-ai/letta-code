import { apiRequest } from "./request";

export interface EphemeralConversationCreateBody {
  [key: string]: unknown;
  model: string;
  system: string;
  model_settings?: Record<string, unknown>;
  context_window_limit?: number | null;
  /** Supplies MCP servers, secrets and permissions; does not own history. */
  parent_agent_id?: string;
  is_subagent?: boolean;
  name?: string;
}

export interface EphemeralConversation {
  id: string;
  agent_id: null;
  model: string;
  context_window_limit: number | null;
}

export async function createEphemeralConversation(
  body: EphemeralConversationCreateBody,
): Promise<EphemeralConversation> {
  return apiRequest<EphemeralConversation>(
    "POST",
    "/v1/conversations/ephemeral",
    body,
  );
}
