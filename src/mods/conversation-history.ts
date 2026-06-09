import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend, ConversationMessageListBody } from "@/backend";
import type { ModConversationHistoryOptions } from "@/mods/types";

const DEFAULT_MOD_CONVERSATION_HISTORY_LIMIT = 100;
const MAX_MOD_CONVERSATION_HISTORY_LIMIT = 500;

function normalizeModConversationHistoryLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_MOD_CONVERSATION_HISTORY_LIMIT;
  if (!Number.isFinite(limit)) {
    return DEFAULT_MOD_CONVERSATION_HISTORY_LIMIT;
  }
  return Math.min(
    Math.max(1, Math.trunc(limit)),
    MAX_MOD_CONVERSATION_HISTORY_LIMIT,
  );
}

export async function loadModConversationHistoryFromBackend(
  backend: Pick<Backend, "listConversationMessages">,
  scope: {
    agentId?: string | null;
    conversationId?: string | null;
  },
  options?: ModConversationHistoryOptions,
): Promise<Message[]> {
  const conversationId = scope.conversationId ?? "default";
  const agentId = scope.agentId ?? null;
  if (!scope.conversationId && !agentId) {
    return [];
  }

  const page = await backend.listConversationMessages(conversationId, {
    limit: normalizeModConversationHistoryLimit(options?.limit),
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
