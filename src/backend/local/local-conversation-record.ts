import type {
  ConversationCreateBody,
  ConversationUpdateBody,
} from "@/backend/backend";
import {
  normalizeLocalModelHandle,
  supportedConversationModelSettingsFromBody,
} from "./local-model-normalization";
import type { StoredConversation } from "./local-types";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

export function createLocalConversationRecord(
  conversationId: string,
  agentId: string | null,
  _sequence: number,
  body: Partial<ConversationCreateBody> = {},
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const now = new Date().toISOString();
  const modelSettings = supportedConversationModelSettingsFromBody(bodyRecord);
  return {
    id: conversationId,
    agent_id: agentId,
    ...(agentId === null
      ? {
          parent_agent_id: bodyRecord.parent_agent_id,
          is_subagent: bodyRecord.is_subagent === true,
          ...(typeof bodyRecord.name === "string"
            ? { name: bodyRecord.name }
            : {}),
          ...(typeof bodyRecord.system === "string"
            ? { system: bodyRecord.system }
            : {}),
        }
      : {}),
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
  } as StoredConversation;
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
    if (current.agent_id === null && bodyRecord.model === null) {
      throw new Error("Worker conversation requires a model");
    }
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
  if (current.agent_id === null && typeof bodyRecord.system === "string") {
    next.system = bodyRecord.system;
  }
  return next;
}

/** Keep a fork's model and explicit parent lineage with its source. */
export function localConversationForkBody(
  source: StoredConversation,
  targetAgentId: string | null,
  hidden?: boolean,
): Partial<ConversationCreateBody> {
  return {
    summary: source.summary ?? null,
    ...(source.model !== undefined ? { model: source.model } : {}),
    ...(source.model_settings !== undefined
      ? { model_settings: source.model_settings }
      : {}),
    ...(typeof source.context_window_limit === "number"
      ? { context_window_limit: source.context_window_limit }
      : {}),
    ...(typeof hidden === "boolean" ? { hidden } : {}),
    ...(targetAgentId === null
      ? {
          parent_agent_id: source.parent_agent_id,
          is_subagent: source.is_subagent,
          name: source.name,
          system: source.system,
        }
      : {}),
  } as Partial<ConversationCreateBody>;
}
