import type {
  AgentMessageListBody,
  ConversationMessageListBody,
} from "@/backend/backend";
import {
  getCursor,
  getIncludedMessageTypes,
  getListLimit,
  getListOrder,
} from "./local-message-list-options";
import { projectedMessageCursorIndex } from "./local-message-projection";
import type { StoredMessage } from "./local-types";

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
