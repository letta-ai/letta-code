import type {
  AgentMessageListBody,
  ConversationMessageListBody,
} from "@/backend/backend";
import { projectedMessageCursorIndex } from "./local-message-projection";
import type { StoredMessage } from "./local-types";

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

function getIncludedMessageTypes(
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

export function applyLocalMessageListOptions(
  messages: StoredMessage[],
  body?: ConversationMessageListBody | AgentMessageListBody,
): StoredMessage[] {
  let start = 0;
  let end = messages.length;
  for (const boundary of ["before", "after"] as const) {
    const cursor = getCursor(body, boundary);
    if (!cursor) continue;
    const index = projectedMessageCursorIndex(messages, cursor, boundary);
    if (index < 0) return [];
    if (boundary === "before") end = index;
    else start = index + 1;
  }
  let items = messages.slice(start, end);
  const includedMessageTypes = getIncludedMessageTypes(body);
  if (includedMessageTypes) {
    items = items.filter((message) =>
      includedMessageTypes.has(message.message_type),
    );
  }

  if (getListOrder(body) === "desc") {
    items = [...items].reverse();
  } else {
    items = [...items];
  }

  const limit = getListLimit(body);
  return limit === undefined ? items : items.slice(0, limit);
}
