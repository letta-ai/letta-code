import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend, ConversationMessageListBody } from "@/backend";
import type { ExtensionConversationHistoryOptions } from "@/extensions/types";

const DEFAULT_EXTENSION_CONVERSATION_HISTORY_LIMIT = 100;
const MAX_EXTENSION_CONVERSATION_HISTORY_LIMIT = 500;

function normalizeExtensionConversationHistoryLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_EXTENSION_CONVERSATION_HISTORY_LIMIT;
  if (!Number.isFinite(limit)) {
    return DEFAULT_EXTENSION_CONVERSATION_HISTORY_LIMIT;
  }
  return Math.min(
    Math.max(1, Math.trunc(limit)),
    MAX_EXTENSION_CONVERSATION_HISTORY_LIMIT,
  );
}

export async function loadExtensionConversationHistoryFromBackend(
  backend: Pick<Backend, "listConversationMessages">,
  scope: {
    agentId?: string | null;
    conversationId?: string | null;
  },
  options?: ExtensionConversationHistoryOptions,
): Promise<Message[]> {
  const conversationId = scope.conversationId ?? "default";
  const agentId = scope.agentId ?? null;
  if (!scope.conversationId && !agentId) {
    return [];
  }

  const page = await backend.listConversationMessages(conversationId, {
    limit: normalizeExtensionConversationHistoryLimit(options?.limit),
    order: "desc",
    include_err: options?.includeErrors ?? true,
    ...(conversationId === "default" && agentId ? { agent_id: agentId } : {}),
  } as ConversationMessageListBody);
  const messages = page.getPaginatedItems() as Message[];
  if (options?.order === "desc") {
    return messages;
  }
  return [...messages].reverse();
}
