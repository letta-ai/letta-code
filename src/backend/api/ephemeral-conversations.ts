import type { ApiFetchOptions } from "./request";
import { apiRequest } from "./request";

export interface EphemeralConversationCreateBody {
  [key: string]: unknown;
  model: string;
  system: string;
  parent_agent_id?: string;
  name?: string;
  is_subagent?: boolean;
  model_settings?: Record<string, unknown>;
  context_window_limit?: number | null;
}

export interface EphemeralConversation {
  id: string;
  agent_id: null;
  model: string;
  context_window_limit: number | null;
  name?: string | null;
  parent_agent_id?: string | null;
  is_subagent?: boolean;
}

export async function createEphemeralConversation(
  body: EphemeralConversationCreateBody,
  options: Omit<ApiFetchOptions, "method" | "body"> = {},
): Promise<EphemeralConversation> {
  return apiRequest<EphemeralConversation>(
    "POST",
    "/v1/conversations/ephemeral",
    body,
    options,
  );
}
