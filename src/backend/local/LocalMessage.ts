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
}

export type LocalMessage = UIMessage<LocalMessageMetadata>;
