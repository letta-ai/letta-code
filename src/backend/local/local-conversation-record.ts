import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  ConversationCreateBody,
  ConversationUpdateBody,
} from "@/backend/backend";
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
  name?: string | null;
  is_subagent?: boolean;
};

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function createLocalConversationRecord(
  conversationId: string,
  agentId: string,
  _sequence: number,
  body: Partial<ConversationCreateBody> = {},
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const now = new Date().toISOString();
  const modelSettings = supportedConversationModelSettingsFromBody(bodyRecord);
  return {
    id: conversationId,
    agent_id: agentId,
    archived: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_message_at: null,
    summary: typeof bodyRecord.summary === "string" ? bodyRecord.summary : null,
    in_context_message_ids: [],
    ...(typeof bodyRecord.name === "string" || bodyRecord.name === null
      ? { name: bodyRecord.name }
      : {}),
    ...(typeof bodyRecord.is_subagent === "boolean"
      ? { is_subagent: bodyRecord.is_subagent }
      : {}),
    ...(typeof bodyRecord.model === "string" || bodyRecord.model === null
      ? {
          model:
            bodyRecord.model === null
              ? null
              : normalizeLocalModelHandle(
                  bodyRecord.model,
                  modelSettings ?? {},
                ),
        }
      : {}),
    ...(modelSettings !== undefined ? { model_settings: modelSettings } : {}),
    ...(typeof bodyRecord.context_window_limit === "number"
      ? { context_window_limit: bodyRecord.context_window_limit }
      : {}),
    ...(typeof bodyRecord.hidden === "boolean"
      ? { hidden: bodyRecord.hidden }
      : {}),
    ...(isStringArray(bodyRecord.tags) ? { tags: bodyRecord.tags } : {}),
  } as StoredConversation;
}

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
  )
    next.last_message_at = bodyRecord.last_message_at;
  if (typeof bodyRecord.model === "string" || bodyRecord.model === null) {
    next.model =
      bodyRecord.model === null
        ? null
        : normalizeLocalModelHandle(bodyRecord.model, modelSettings ?? {});
  }
  if (modelSettings !== undefined)
    next.model_settings = modelSettings as StoredConversation["model_settings"];
  if (typeof bodyRecord.context_window_limit === "number") {
    (next as unknown as Record<string, unknown>).context_window_limit =
      bodyRecord.context_window_limit;
  }
  if (typeof bodyRecord.hidden === "boolean") next.hidden = bodyRecord.hidden;
  if (typeof bodyRecord.summary === "string" || bodyRecord.summary === null)
    next.summary = bodyRecord.summary;
  if (typeof bodyRecord.name === "string" || bodyRecord.name === null)
    next.name = bodyRecord.name;
  if (typeof bodyRecord.is_subagent === "boolean")
    next.is_subagent = bodyRecord.is_subagent;
  if (isStringArray(bodyRecord.tags)) next.tags = bodyRecord.tags;
  return next;
}
