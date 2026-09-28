/**
 * Shared types for the local backend — extracted here to avoid circular
 * imports between LocalStore, LocalMessageProjection, compaction, and
 * systemPromptCompilation.
 */
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";

export type StoredMessage = Omit<Message, "agent_id"> & {
  id: string;
  message_type: string;
  date: string;
  content?: unknown;
  agent_id: string | null;
  conversation_id: string;
};

export interface LocalAgentRecord {
  id: string;
  name: string;
  description?: string | null;
  system: string;
  tags: string[];
  model: string;
  model_settings: Record<string, unknown>;
  hidden?: boolean | null;
  compaction_settings?: Record<string, unknown> | null;
}

export type StoredConversation = Omit<Conversation, "agent_id"> & {
  id: string;
  agent_id: string | null;
  parent_agent_id?: string | null;
  system?: string;
  context_window_limit?: number | null;
  name?: string | null;
  is_subagent?: boolean;
  in_context_message_ids: string[];
  hidden?: boolean;
  tags?: string[];
};
