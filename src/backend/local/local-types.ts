/**
 * Shared types for the local backend — extracted here to avoid circular
 * imports between LocalStore, LocalMessageProjection, compaction, and
 * systemPromptCompilation.
 */
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";

export type StoredMessage = Message & {
  id: string;
  message_type: string;
  date: string;
  content?: unknown;
  agent_id: string;
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

export type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
  hidden?: boolean;
  tags?: string[];
};
