import type {
  ConversationCreateBody,
  ConversationUpdateBody,
} from "@/backend/backend";
import { isRecord } from "@/utils/type-guards";
import {
  normalizeLocalModelHandle,
  supportedConversationModelSettingsFromBody,
} from "./local-model-normalization";
import type { LocalAgentRecord, StoredConversation } from "./local-types";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createLocalConversationRecord(
  conversationId: string,
  agentId: string | null,
  body: Partial<ConversationCreateBody> = {},
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const now = new Date().toISOString();
  const modelSettings = supportedConversationModelSettingsFromBody(bodyRecord);
  return {
    id: conversationId,
    agent_id: agentId,
    ...(agentId === null && {
      system: optionalString(bodyRecord.system) ?? "",
      parent_agent_id: optionalString(bodyRecord.parent_agent_id) ?? null,
      name: optionalString(bodyRecord.name) ?? null,
      is_subagent: bodyRecord.is_subagent === true,
    }),
    archived: false,
    archived_at: null,
    created_at: now,
    updated_at: now,
    last_message_at: null,
    summary: optionalString(bodyRecord.summary) ?? null,
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

export function createLocalForkRecord(input: {
  id: string;
  source: StoredConversation;
  owner: string | null;
  sourceAgent?: LocalAgentRecord;
  sourceSystem?: string;
  hidden?: boolean;
  name?: string;
  isSubagent?: boolean;
}): StoredConversation {
  const { id, source, owner, sourceAgent } = input;
  const model =
    owner === null
      ? (source.model ?? sourceAgent?.model ?? "local/default")
      : source.model;
  const sourceSettings = isRecord(source.model_settings)
    ? source.model_settings
    : {};
  // Only inherit settings from an agent-backed source using that same model.
  // A detached source already owns its snapshot; never read its parent again.
  const settings =
    owner === null &&
    source.agent_id !== null &&
    sourceAgent &&
    sourceAgent.model === model
      ? { ...sourceAgent.model_settings, ...sourceSettings }
      : { ...sourceSettings };
  return createLocalConversationRecord(id, owner, {
    summary: source.summary ?? null,
    ...(model !== undefined ? { model } : {}),
    ...(owner === null || source.model_settings !== undefined
      ? { model_settings: settings }
      : {}),
    ...(typeof source.context_window_limit === "number"
      ? { context_window_limit: source.context_window_limit }
      : {}),
    ...(owner === null
      ? {
          system:
            input.sourceSystem ?? source.system ?? sourceAgent?.system ?? "",
          parent_agent_id: source.agent_id ?? source.parent_agent_id ?? null,
          name: input.name ?? source.name ?? null,
          is_subagent: input.isSubagent ?? source.is_subagent ?? false,
        }
      : {}),
    ...(typeof input.hidden === "boolean" ? { hidden: input.hidden } : {}),
  } as Partial<ConversationCreateBody>);
}

export function withLocalConversationModelDefaults(
  conversation: StoredConversation,
  defaultsForModel: (model: string) => Record<string, unknown> | undefined,
): StoredConversation {
  const requestedModel = conversation.model;
  if (typeof requestedModel !== "string") return conversation;
  const normalizedRequestedModel = normalizeLocalModelHandle(
    requestedModel,
    isRecord(conversation.model_settings) ? conversation.model_settings : {},
  );
  const defaults = defaultsForModel(normalizedRequestedModel);
  if (!defaults || Object.keys(defaults).length === 0) return conversation;
  const existingSettings = isRecord(conversation.model_settings)
    ? conversation.model_settings
    : {};
  return {
    ...conversation,
    model: normalizedRequestedModel,
    model_settings: { ...defaults, ...existingSettings },
  };
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
  if (typeof bodyRecord.summary === "string" || bodyRecord.summary === null)
    next.summary = bodyRecord.summary;
  if (isStringArray(bodyRecord.tags)) next.tags = bodyRecord.tags;
  return next;
}
