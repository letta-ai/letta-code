import type { UIMessage } from "ai";

export interface LocalMessageProviderMetadata {
  provider_id?: string;
  model_id?: string;
  response_id?: string;
  provider_metadata?: unknown;
  warnings?: unknown[];
  usage?: unknown;
}

export interface LocalMessageMetadata {
  created_at?: string;
  updated_at?: string;
  agent_id?: string;
  conversation_id?: string;
  provider?: LocalMessageProviderMetadata;
  compaction?: {
    summary: string;
    stats?: {
      trigger?: string;
      context_tokens_before?: number;
      context_tokens_after?: number;
      context_window?: number;
      messages_count_before?: number;
      messages_count_after?: number;
    };
  };
}

export type LocalMessage = UIMessage<LocalMessageMetadata>;
