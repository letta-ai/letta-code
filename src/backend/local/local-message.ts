import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message as PiMessage,
  ProviderId,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";

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

export interface LocalMessageBase {
  id: string;
  metadata?: LocalMessageMetadata;
}

export type LocalTextContent = TextContent;
export type LocalThinkingContent = ThinkingContent;
export type LocalImageContent = ImageContent;
export type LocalToolCall = ToolCall;

export interface LocalUserMessage
  extends Omit<UserMessage, "timestamp">,
    LocalMessageBase {
  role: "user";
  otid?: string;
  timestamp: number;
}

export interface LocalAssistantMessage
  extends Omit<AssistantMessage, "timestamp" | "usage">,
    LocalMessageBase {
  role: "assistant";
  content: (LocalTextContent | LocalThinkingContent | LocalToolCall)[];
  api: Api;
  provider: ProviderId;
  model: string;
  usage: Usage;
  timestamp: number;
}

export interface LocalToolResultMessage
  extends Omit<ToolResultMessage, "timestamp">,
    LocalMessageBase {
  role: "toolResult";
  content: (LocalTextContent | LocalImageContent)[];
  timestamp: number;
}

export type LocalMessage =
  | LocalUserMessage
  | LocalAssistantMessage
  | LocalToolResultMessage;

export type LocalPiMessage = PiMessage;

export function emptyLocalUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
