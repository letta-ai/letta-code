import type { ConversationCreateBody, ConversationUpdateBody } from "@/backend";
import {
  normalizeLocalModelHandle,
  supportedConversationModelSettingsFromBody,
} from "./local-model-normalization";
import type { LocalAgentRecord, StoredConversation } from "./local-types";

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

export function createLocalConversationRecord(
  conversationId: string,
  agentId: string,
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
    summary: optionalStringOrNull(bodyRecord.summary) ?? null,
    in_context_message_ids: [],
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
    ...(typeof bodyRecord.system === "string"
      ? { system: bodyRecord.system }
      : {}),
    ...(typeof bodyRecord.parent_agent_id === "string" ||
    bodyRecord.parent_agent_id === null
      ? { parent_agent_id: bodyRecord.parent_agent_id }
      : {}),
    ...(typeof bodyRecord.is_subagent === "boolean"
      ? { is_subagent: bodyRecord.is_subagent }
      : {}),
    ...(typeof bodyRecord.name === "string" ? { name: bodyRecord.name } : {}),
  } as StoredConversation;
}

export function agentFreeExecutionRecord(
  conversation: StoredConversation,
  executionAgentId: string,
): LocalAgentRecord {
  if (typeof conversation.model !== "string" || !conversation.model) {
    throw new Error(
      `Agent-free conversation ${conversation.id} has no persisted model`,
    );
  }
  if (typeof conversation.system !== "string") {
    throw new Error(
      `Agent-free conversation ${conversation.id} has no persisted system prompt`,
    );
  }
  return {
    id: executionAgentId,
    name:
      typeof conversation.name === "string"
        ? conversation.name
        : "Workflow worker",
    system: conversation.system,
    tags: [],
    model: conversation.model,
    model_settings:
      conversation.model_settings &&
      typeof conversation.model_settings === "object" &&
      !Array.isArray(conversation.model_settings)
        ? (conversation.model_settings as unknown as Record<string, unknown>)
        : {},
    hidden: true,
  };
}

export function parsePersistedLocalConversation(
  recordJson: string,
  executionAgentId: (conversationId: string) => string,
): StoredConversation | undefined {
  const persisted = JSON.parse(recordJson) as Omit<
    StoredConversation,
    "agent_id"
  > & { agent_id: string | null };
  if (
    !persisted?.id ||
    (typeof persisted.agent_id !== "string" && persisted.agent_id !== null) ||
    (persisted.agent_id === null && persisted.agent_free !== true)
  ) {
    return undefined;
  }
  return {
    ...persisted,
    agent_id: persisted.agent_id ?? executionAgentId(persisted.id),
  };
}

export function updateLocalConversationRecord(
  current: StoredConversation,
  body: ConversationUpdateBody,
  updatedAt: string,
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const next: StoredConversation = {
    ...current,
    updated_at: updatedAt,
  };
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
  if (typeof bodyRecord.hidden === "boolean") {
    next.hidden = bodyRecord.hidden;
  }
  if (typeof bodyRecord.summary === "string" || bodyRecord.summary === null) {
    next.summary = bodyRecord.summary;
  }
  if (isStringArray(bodyRecord.tags)) {
    next.tags = bodyRecord.tags;
  }
  if (isStringArray(bodyRecord.tags_to_add)) {
    next.tags = [...new Set([...(next.tags ?? []), ...bodyRecord.tags_to_add])];
  }
  return next;
}
