import type {
  AgentMessageListBody,
  ConversationMessageListBody,
} from "@/backend/backend";

export function getListLimit(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const limit = (body as { limit?: unknown } | undefined)?.limit;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

export function getListOrder(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const order = (body as { order?: unknown } | undefined)?.order;
  return order === "asc" ? "asc" : "desc";
}

export function getCursor(
  body: ConversationMessageListBody | AgentMessageListBody | undefined,
  key: "before" | "after",
): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getIncludedMessageTypes(
  body?: ConversationMessageListBody | AgentMessageListBody,
): Set<string> | undefined {
  const value = (body as Record<string, unknown> | undefined)
    ?.include_return_message_types;
  if (!Array.isArray(value)) return undefined;

  const messageTypes = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return messageTypes.length > 0 ? new Set(messageTypes) : undefined;
}
