export interface RuntimeScope<AgentId extends string | null = string> {
  agent_id: AgentId;
  conversation_id: string;
  acting_user_id?: string;
}

export type AgentRuntimeScope = RuntimeScope<string>;
export type ConversationRuntimeScope = RuntimeScope<string | null>;
