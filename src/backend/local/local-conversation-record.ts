import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { ConversationUpdateBody } from "@/backend/backend";
import {
  normalizeLocalModelHandle,
  supportedConversationModelSettingsFromBody,
} from "./local-model-normalization";

export type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
  hidden?: boolean;
  tags?: string[];
};

export function updateLocalConversationRecord(
  current: StoredConversation,
  body: ConversationUpdateBody,
  updatedAt: string,
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const next: StoredConversation = { ...current, updated_at: updatedAt };
  const modelSettings = supportedConversationModelSettingsFromBody(bodyRecord);
  if (typeof bodyRecord.archived === "boolean") {
    next.archived = bodyRecord.archived;
    next.archived_at = bodyRecord.archived
      ? (current.archived_at ?? updatedAt)
      : null;
  }
  if (bodyRecord.archived === null) {
    next.archived = false;
    next.archived_at = null;
  }
  if (
    typeof bodyRecord.last_message_at === "string" ||
    bodyRecord.last_message_at === null
  ) {
    next.last_message_at = bodyRecord.last_message_at;
  }
  if (typeof bodyRecord.model === "string" || bodyRecord.model === null) {
    next.model =
      bodyRecord.model === null
        ? null
        : normalizeLocalModelHandle(bodyRecord.model, modelSettings ?? {});
  }
  if (modelSettings !== undefined) {
    next.model_settings = modelSettings as StoredConversation["model_settings"];
  }
  if (typeof bodyRecord.context_window_limit === "number") {
    (next as unknown as Record<string, unknown>).context_window_limit =
      bodyRecord.context_window_limit;
  }
  if (typeof bodyRecord.hidden === "boolean") next.hidden = bodyRecord.hidden;
  if (typeof bodyRecord.summary === "string" || bodyRecord.summary === null) {
    next.summary = bodyRecord.summary;
  }
  if (
    Array.isArray(bodyRecord.tags) &&
    bodyRecord.tags.every((tag) => typeof tag === "string")
  ) {
    next.tags = bodyRecord.tags;
  }
  if (
    Array.isArray(bodyRecord.tags_to_add) &&
    bodyRecord.tags_to_add.every((tag) => typeof tag === "string")
  ) {
    next.tags = [...new Set([...(next.tags ?? []), ...bodyRecord.tags_to_add])];
  }
  return next;
}
