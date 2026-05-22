import { getBackend } from "@/backend";
import { estimateSystemTokens } from "@/utils/system-prompt-size";
import type { ContextData, ConversationInfo, MessageInfo } from "./types";

type PaginatedItems<T> = T[] | { getPaginatedItems?: () => T[] };

type BackendMessageItem = {
  id?: string | null;
  role?: string | null;
  message_type?: string | null;
  content?: string | unknown[] | unknown;
  conversation_id?: string | null;
  date?: string | null;
  created_at?: string | null;
};

type ConversationListItem = {
  id?: string | null;
  created_at?: string | null;
  last_run_completion?: string | null;
  label?: string | null;
};

export interface LocalMemoryContextData {
  agentName?: string;
  model?: string;
  context?: ContextData;
  messages?: MessageInfo[];
  conversations?: ConversationInfo[];
}

function getPaginatedItems<T>(value: PaginatedItems<T>): T[] {
  if (Array.isArray(value)) return value;
  return value.getPaginatedItems?.() ?? [];
}

function estimateStoredMessageTokens(messages: BackendMessageItem[]): number {
  const chars = messages.reduce(
    (total, message) => total + JSON.stringify(message).length,
    0,
  );
  return Math.ceil(chars / 4);
}

function messageInfoFromBackendMessage(
  message: BackendMessageItem,
): MessageInfo | null {
  const id = message.id;
  const createdAt = message.date ?? message.created_at;
  if (!id || !createdAt) return null;
  return {
    id,
    role: message.role ?? message.message_type ?? "unknown",
    content:
      typeof message.content === "string" || Array.isArray(message.content)
        ? message.content
        : message.content === undefined
          ? ""
          : [message.content],
    conversation_id: message.conversation_id ?? null,
    created_at: createdAt,
  };
}

export async function collectLocalMemoryContextData(
  agentId: string,
  conversationId?: string,
): Promise<LocalMemoryContextData> {
  const backend = getBackend();
  if (!backend.capabilities.localMemfs) return {};

  const targetConversationId = conversationId ?? "default";
  const agent = await backend.retrieveAgent(agentId);
  const agentName = agent.name ?? undefined;
  const model = agent.llm_config?.model ?? agent.model ?? "unknown";
  const contextWindow = agent.llm_config?.context_window ?? 0;

  const [compiledPrompt, messagePage, conversationPage] = await Promise.all([
    backend
      .recompileConversation(targetConversationId, {
        agent_id: agentId,
        dry_run: true,
        update_timestamp: false,
      } as never)
      .catch(() => ""),
    backend.listConversationMessages(targetConversationId, {
      agent_id: agentId,
      order: "asc",
    } as never),
    backend
      .listConversations({
        agent_id: agentId,
        limit: 10,
        order: "desc",
        order_by: "last_run_completion",
      } as never)
      .catch(() => []),
  ]);

  const backendMessages = getPaginatedItems(
    messagePage as PaginatedItems<BackendMessageItem>,
  );
  const messages = backendMessages.flatMap((message) => {
    const info = messageInfoFromBackendMessage(message);
    return info ? [info] : [];
  });
  const systemTokens =
    typeof compiledPrompt === "string" && compiledPrompt.length > 0
      ? estimateSystemTokens(compiledPrompt)
      : 0;
  const messageTokens = estimateStoredMessageTokens(backendMessages);
  const conversations = getPaginatedItems(
    conversationPage as PaginatedItems<ConversationListItem>,
  ).flatMap((conversation) => {
    if (!conversation.id || !conversation.created_at) return [];
    return [
      {
        id: conversation.id,
        created_at: conversation.created_at,
        last_run_completion: conversation.last_run_completion ?? null,
        label: conversation.label ?? null,
      },
    ];
  });

  return {
    agentName,
    model,
    messages,
    conversations,
    context: {
      contextWindow,
      usedTokens: systemTokens + messageTokens,
      model,
      breakdown: {
        system: systemTokens,
        coreMemory: 0,
        externalMemory: 0,
        summaryMemory: 0,
        tools: 0,
        messages: messageTokens,
      },
    },
  };
}
