import type { AgentCreateParams } from "@letta-ai/letta-client/resources/agents/agents";
import type { ConversationCreateParams } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { EphemeralConversationCreateBody } from "@/backend/api/ephemeral-conversations";

export interface RuntimeStartCreateAgentOptions {
  /** Body forwarded to the Letta agents create API. */
  body: AgentCreateParams;
  /** Whether to pin the created agent globally. Defaults to true. */
  pin_global?: boolean;
  /** Disable for worker-style agents whose memory scope is provided per session. */
  memfs?: boolean;
}

export interface RuntimeStartCreateConversationOptions {
  /** Agent-backed create body, or an agent-free model and system prompt when no agent is supplied. */
  body?:
    | Omit<ConversationCreateParams, "agent_id">
    | EphemeralConversationCreateBody;
}

export interface RuntimeStartClientInfo {
  name: string;
  title?: string;
  version?: string;
}
