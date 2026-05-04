import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  LettaStreamingResponse,
  Message,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  AgentCreateBody,
  AgentListBody,
  AgentMessageListBody,
  AgentUpdateBody,
  ConversationCreateBody,
  ConversationListBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationUpdateBody,
} from "../backend";
import type { LocalMessage } from "./LocalMessage";
import {
  cloneLocalMessage,
  isLocalToolPart,
  mergeSnapshotPartsWithExistingTools,
  projectedMessageLookupKeys,
  projectLocalMessagesToStoredMessages,
  projectLocalMessageToStoredMessages,
} from "./LocalMessageProjection";
import {
  getAttachedLocalUIMessage,
  isLocalStateChunkOnly,
} from "./LocalStreamChunks";
import type { LocalCompiledSystemPrompt } from "./systemPromptCompilation";

export type StoredMessage = Message & {
  id: string;
  message_type: string;
  date: string;
  content?: unknown;
  agent_id: string;
  conversation_id: string;
};

type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
};

export interface LocalAgentRecord {
  id: string;
  name: string;
  description?: string | null;
  system: string;
  tags: string[];
  model: string;
  model_settings: Record<string, unknown>;
}

const DEFAULT_LOCAL_AGENT_NAME = "Letta Code";
const DEFAULT_LOCAL_MODEL = "local/default";
const DEFAULT_LOCAL_CONVERSATION_ID_PREFIX = "local-conv-";
const DEFAULT_LOCAL_STORED_MESSAGE_ID_PREFIX = "letta-msg-";
const DEFAULT_LOCAL_UI_MESSAGE_ID_PREFIX = "ui-msg-";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
}

function supportedModelSettingsFromBody(
  bodyRecord: Record<string, unknown>,
): Record<string, unknown> {
  const modelSettings = isRecord(bodyRecord.model_settings)
    ? { ...bodyRecord.model_settings }
    : {};

  if (typeof bodyRecord.context_window_limit === "number") {
    modelSettings.context_window_limit = bodyRecord.context_window_limit;
  }
  if (typeof bodyRecord.parallel_tool_calls === "boolean") {
    modelSettings.parallel_tool_calls = bodyRecord.parallel_tool_calls;
  }
  if (
    typeof bodyRecord.max_tokens === "number" ||
    bodyRecord.max_tokens === null
  ) {
    modelSettings.max_tokens = bodyRecord.max_tokens;
  }

  return modelSettings;
}

function createDefaultAgentRecord(
  agentId: string,
  defaultAgentName: string,
  defaultAgentModel: string,
): LocalAgentRecord {
  return {
    id: agentId,
    name: defaultAgentName,
    description: null,
    system: "",
    tags: [],
    model: defaultAgentModel,
    model_settings: {
      context_window_limit: 128000,
    },
  };
}

function createLocalAgentRecord(
  body: AgentCreateBody,
  defaultAgentName: string,
  defaultAgentModel: string,
): LocalAgentRecord {
  const bodyRecord = body as Record<string, unknown>;
  return {
    id: `agent-local-${randomUUID()}`,
    name: optionalString(bodyRecord.name) ?? defaultAgentName,
    description: optionalStringOrNull(bodyRecord.description) ?? null,
    system: optionalString(bodyRecord.system) ?? "",
    tags: isStringArray(bodyRecord.tags) ? bodyRecord.tags : [],
    model: optionalString(bodyRecord.model) ?? defaultAgentModel,
    model_settings: supportedModelSettingsFromBody(bodyRecord),
  };
}

function shouldUseDefaultLocalModel(model: unknown): boolean {
  return (
    typeof model !== "string" ||
    model.length === 0 ||
    model === "auto" ||
    model.startsWith("letta/")
  );
}

function timestampForSequence(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
}

function optionalRecordOrNull(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? { ...value } : undefined;
}

function conversationModelSettings(
  value: unknown,
): Record<string, unknown> | null | undefined {
  return optionalRecordOrNull(value);
}

function createLocalConversationRecord(
  conversationId: string,
  agentId: string,
  sequence: number,
  body: Partial<ConversationCreateBody> = {},
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const now = timestampForSequence(sequence);
  const modelSettings = conversationModelSettings(bodyRecord.model_settings);
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
      ? { model: bodyRecord.model }
      : {}),
    ...(modelSettings !== undefined ? { model_settings: modelSettings } : {}),
  } as StoredConversation;
}

function updateLocalConversationRecord(
  current: StoredConversation,
  body: ConversationUpdateBody,
  updatedAt: string,
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const next: StoredConversation = {
    ...current,
    updated_at: updatedAt,
  };
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
    next.model = bodyRecord.model;
  }
  const modelSettings = conversationModelSettings(bodyRecord.model_settings);
  if (modelSettings !== undefined) {
    next.model_settings = modelSettings as StoredConversation["model_settings"];
  }
  if (typeof bodyRecord.summary === "string" || bodyRecord.summary === null) {
    next.summary = bodyRecord.summary;
  }
  return next;
}

function normalizeAgentRecord(
  value: unknown,
  defaultAgentModel: string,
): LocalAgentRecord | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const modelSettings = isRecord(value.model_settings)
    ? { ...value.model_settings }
    : {};
  const legacyLlmConfig = isRecord(value.llm_config) ? value.llm_config : {};
  if (
    modelSettings.context_window_limit === undefined &&
    typeof legacyLlmConfig.context_window === "number"
  ) {
    modelSettings.context_window_limit = legacyLlmConfig.context_window;
  }
  if (
    modelSettings.max_tokens === undefined &&
    (typeof legacyLlmConfig.max_tokens === "number" ||
      legacyLlmConfig.max_tokens === null)
  ) {
    modelSettings.max_tokens = legacyLlmConfig.max_tokens;
  }

  return {
    id: value.id,
    name: optionalString(value.name) ?? "Letta Code",
    description: optionalStringOrNull(value.description) ?? null,
    system: optionalString(value.system) ?? "",
    tags: isStringArray(value.tags) ? value.tags : [],
    model:
      optionalString(value.model) ??
      optionalString(legacyLlmConfig.model) ??
      defaultAgentModel,
    model_settings: modelSettings,
  };
}

function projectAgentState(
  record: LocalAgentRecord,
  messageIds: string[] = [],
  inContextMessageIds: string[] = messageIds,
  lastRunCompletion?: string | null,
): AgentState {
  const nestedReasoning = isRecord(record.model_settings.reasoning)
    ? record.model_settings.reasoning
    : undefined;
  const reasoningEffort =
    typeof nestedReasoning?.reasoning_effort === "string"
      ? nestedReasoning.reasoning_effort
      : typeof record.model_settings.effort === "string"
        ? record.model_settings.effort
        : typeof record.model_settings.reasoning_effort === "string"
          ? record.model_settings.reasoning_effort
          : undefined;
  const enableReasoner =
    isRecord(record.model_settings.thinking) &&
    record.model_settings.thinking.type === "disabled"
      ? false
      : typeof record.model_settings.enable_reasoner === "boolean"
        ? record.model_settings.enable_reasoner
        : undefined;
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    system: record.system,
    tools: [],
    tags: record.tags,
    model: record.model,
    model_settings: record.model_settings,
    message_ids: messageIds,
    in_context_message_ids: inContextMessageIds,
    ...(lastRunCompletion ? { last_run_completion: lastRunCompletion } : {}),
    // Temporary compatibility shim for older runtime call sites. Local storage
    // keeps only `model` + `model_settings`.
    llm_config: {
      model: record.model,
      model_endpoint_type: "openai",
      model_endpoint: "https://example.invalid/v1",
      context_window:
        typeof record.model_settings.context_window_limit === "number"
          ? record.model_settings.context_window_limit
          : 128000,
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      ...(enableReasoner !== undefined && { enable_reasoner: enableReasoner }),
      ...((typeof record.model_settings.max_tokens === "number" ||
        record.model_settings.max_tokens === null) && {
        max_tokens: record.model_settings.max_tokens,
      }),
    },
  } as unknown as AgentState;
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    return textContent(content);
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function getListLimit(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const limit = (body as { limit?: unknown } | undefined)?.limit;
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

function getListOrder(
  body?: ConversationMessageListBody | AgentMessageListBody,
) {
  const order = (body as { order?: unknown } | undefined)?.order;
  return order === "asc" ? "asc" : "desc";
}

function getCursor(
  body: ConversationMessageListBody | AgentMessageListBody | undefined,
  key: "before" | "after",
): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toStoredOutputFields(chunk: Record<string, unknown>) {
  const { id: _id, date: _date, agent_id, conversation_id, ...fields } = chunk;
  void agent_id;
  void conversation_id;
  return fields;
}

export interface StoredTurnInput {
  agentId: string;
  conversationId: string;
}

export interface LocalStoreOptions {
  storageDir?: string;
  seedDefaultAgent?: boolean;
  strictAgentAccess?: boolean;
  strictConversationAccess?: boolean;
  defaultAgentName?: string;
  defaultAgentModel?: string;
  defaultAgentModelSettings?: Record<string, unknown>;
  conversationIdPrefix?: string;
  storedMessageIdPrefix?: string;
  localMessageIdPrefix?: string;
}

export class LocalBackendNotFoundError extends Error {
  readonly status = 404;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = "LocalBackendNotFoundError";
  }
}

type LocalMessagePart = LocalMessage["parts"][number];
type LocalToolPart = LocalMessagePart & {
  type: `tool-${string}`;
  toolCallId: string;
};
type LocalTextPart = LocalMessagePart & {
  type: "text";
  text: string;
  state?: "streaming" | "done";
  providerMetadata?: unknown;
};
type LocalReasoningPart = LocalMessagePart & {
  type: "reasoning";
  text: string;
  state?: "streaming" | "done";
  providerMetadata?: unknown;
};

function isSettledLocalToolState(state: unknown): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function encodePathSegment(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function jsonl<T>(items: T[]): string {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

function numericSuffix(value: string, prefix: string): number {
  return value.startsWith(prefix)
    ? Number.parseInt(value.slice(prefix.length), 10) || 0
    : 0;
}

function createdAtForLocalMessage(message: LocalMessage): string | undefined {
  return typeof message.metadata?.created_at === "string"
    ? message.metadata.created_at
    : undefined;
}

function localMessageDate(message: LocalMessage, fallbackDate: string): string {
  return createdAtForLocalMessage(message) ?? fallbackDate;
}

export class LocalStore {
  private readonly storageDir?: string;
  private readonly strictAgentAccess: boolean;
  private readonly strictConversationAccess: boolean;
  private readonly defaultAgentName: string;
  private readonly defaultAgentModel: string;
  private readonly defaultAgentModelSettings: Record<string, unknown>;
  private readonly conversationIdPrefix: string;
  private readonly storedMessageIdPrefix: string;
  private readonly localMessageIdPrefix: string;
  private readonly agents = new Map<string, LocalAgentRecord>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly localMessagesByConversationKey = new Map<
    string,
    LocalMessage[]
  >();
  private readonly compiledSystemPromptByConversationKey = new Map<
    string,
    LocalCompiledSystemPrompt
  >();
  private readonly messagesById = new Map<string, StoredMessage[]>();
  private conversationSeq = 0;
  private messageSeq = 0;
  private localMessageSeq = 0;

  constructor(
    private readonly defaultAgentId: string,
    options: LocalStoreOptions = {},
  ) {
    this.storageDir = options.storageDir;
    this.strictAgentAccess = options.strictAgentAccess === true;
    this.strictConversationAccess =
      options.strictConversationAccess ?? this.strictAgentAccess;
    this.defaultAgentName =
      options.defaultAgentName ?? DEFAULT_LOCAL_AGENT_NAME;
    this.defaultAgentModel = options.defaultAgentModel ?? DEFAULT_LOCAL_MODEL;
    this.defaultAgentModelSettings = {
      ...(options.defaultAgentModelSettings ?? {}),
    };
    this.conversationIdPrefix =
      options.conversationIdPrefix ?? DEFAULT_LOCAL_CONVERSATION_ID_PREFIX;
    this.storedMessageIdPrefix =
      options.storedMessageIdPrefix ?? DEFAULT_LOCAL_STORED_MESSAGE_ID_PREFIX;
    this.localMessageIdPrefix =
      options.localMessageIdPrefix ?? DEFAULT_LOCAL_UI_MESSAGE_ID_PREFIX;
    this.loadFromStorage();
    if (options.seedDefaultAgent !== false) {
      this.ensureAgent(this.defaultAgentId);
    }
  }

  retrieveAgent(agentId: string): AgentState {
    if (!this.strictAgentAccess) {
      return this.ensureAgent(agentId);
    }
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    return this.projectAgent(existing);
  }

  listAgents(body?: AgentListBody): { items: AgentState[] } {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const queryText = optionalString(bodyRecord.query_text)?.toLowerCase();
    const tags = isStringArray(bodyRecord.tags) ? bodyRecord.tags : [];
    const after = optionalString(bodyRecord.after);
    const limit = typeof bodyRecord.limit === "number" ? bodyRecord.limit : 20;
    let agents = [...this.agents.values()].map((agent) =>
      this.projectAgent(agent),
    );

    if (tags.length > 0) {
      agents = agents.filter((agent) =>
        tags.every((tag) => agent.tags?.includes(tag)),
      );
    }
    if (queryText) {
      agents = agents.filter((agent) => {
        const haystack = [agent.name, agent.description, agent.id, agent.model]
          .filter((value): value is string => typeof value === "string")
          .join("\n")
          .toLowerCase();
        return haystack.includes(queryText);
      });
    }
    agents.sort((a, b) => {
      const aDate =
        (a as { last_run_completion?: string | null }).last_run_completion ??
        "";
      const bDate =
        (b as { last_run_completion?: string | null }).last_run_completion ??
        "";
      return bDate.localeCompare(aDate);
    });
    if (after) {
      const afterIndex = agents.findIndex((agent) => agent.id === after);
      if (afterIndex >= 0) agents = agents.slice(afterIndex + 1);
    }

    return { items: agents.slice(0, limit) };
  }

  deleteAgent(agentId: string): void {
    if (this.strictAgentAccess && !this.agents.has(agentId)) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    this.agents.delete(agentId);
    for (const [key, conversation] of [...this.conversations.entries()]) {
      if (conversation.agent_id === agentId) {
        this.conversations.delete(key);
        this.localMessagesByConversationKey.delete(key);
        if (this.storageDir) {
          rmSync(
            join(this.storageDir, "conversations", encodePathSegment(key)),
            {
              recursive: true,
              force: true,
            },
          );
        }
      }
    }
    if (this.storageDir) {
      rmSync(
        join(this.storageDir, "agents", `${encodePathSegment(agentId)}.json`),
        { force: true },
      );
    }
  }

  retrieveAgentRecord(agentId: string): LocalAgentRecord {
    if (!this.strictAgentAccess) {
      this.ensureAgent(agentId);
    }
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    return existing;
  }

  ensureAgent(agentId: string): AgentState {
    const existing = this.agents.get(agentId);
    if (existing) return this.projectAgent(existing);
    const agent = this.createDefaultAgentRecord(agentId);
    this.agents.set(agentId, agent);
    this.persistAgent(agentId);
    this.ensureConversation("default", agentId);
    return this.projectAgent(agent);
  }

  updateAgent(agentId: string, body: AgentUpdateBody): AgentState {
    const currentRecord = this.agents.get(agentId);
    if (!currentRecord) {
      if (this.strictAgentAccess) {
        throw new LocalBackendNotFoundError("Agent", agentId);
      }
      this.ensureAgent(agentId);
    }
    const existingRecord =
      currentRecord ??
      this.agents.get(agentId) ??
      this.createDefaultAgentRecord(agentId);
    const bodyRecord = body as Record<string, unknown>;
    const nextSystem =
      typeof bodyRecord.system === "string" ? bodyRecord.system : undefined;
    const systemChanged =
      nextSystem !== undefined && nextSystem !== existingRecord.system;
    const requestedModel = bodyRecord.model;
    const nextModelSettings = {
      ...existingRecord.model_settings,
      ...(shouldUseDefaultLocalModel(requestedModel)
        ? this.defaultAgentModelSettings
        : {}),
      ...supportedModelSettingsFromBody(bodyRecord),
    };
    const nextModel =
      typeof requestedModel === "string" &&
      !shouldUseDefaultLocalModel(requestedModel)
        ? requestedModel
        : typeof requestedModel === "string" && this.defaultAgentModel
          ? this.defaultAgentModel
          : undefined;
    const updated = {
      ...existingRecord,
      ...(typeof bodyRecord.name === "string" && { name: bodyRecord.name }),
      ...((typeof bodyRecord.description === "string" ||
        bodyRecord.description === null) && {
        description: bodyRecord.description,
      }),
      ...(typeof bodyRecord.system === "string" && {
        system: bodyRecord.system,
      }),
      ...(isStringArray(bodyRecord.tags) && { tags: bodyRecord.tags }),
      ...(nextModel && { model: nextModel }),
      model_settings: nextModelSettings,
    };
    this.agents.set(agentId, updated);
    this.persistAgent(agentId);
    if (systemChanged) {
      this.clearCompiledSystemPromptsForAgent(agentId);
    }
    return this.projectAgent(updated);
  }

  createAgent(body: AgentCreateBody): AgentState {
    const agent = this.createAgentRecord(body);
    const agentId = agent.id;
    this.agents.set(agentId, agent);
    this.persistAgent(agentId);
    this.ensureConversation("default", agentId);
    return this.projectAgent(agent);
  }

  private createDefaultAgentRecord(agentId: string): LocalAgentRecord {
    const agent = createDefaultAgentRecord(
      agentId,
      this.defaultAgentName,
      this.defaultAgentModel,
    );
    return {
      ...agent,
      model: this.defaultAgentModel,
      model_settings: {
        ...agent.model_settings,
        ...this.defaultAgentModelSettings,
      },
    };
  }

  private createAgentRecord(body: AgentCreateBody): LocalAgentRecord {
    const agent = createLocalAgentRecord(
      body,
      this.defaultAgentName,
      this.defaultAgentModel,
    );
    const bodyRecord = body as Record<string, unknown>;
    if (!shouldUseDefaultLocalModel(bodyRecord.model)) {
      return agent;
    }
    return {
      ...agent,
      model: this.defaultAgentModel,
      model_settings: {
        ...this.defaultAgentModelSettings,
        ...agent.model_settings,
      },
    };
  }

  retrieveConversation(conversationId: string, agentId?: string): Conversation {
    const existing = this.findConversation(conversationId, agentId);
    if (existing) return existing;
    if (this.strictConversationAccess) {
      throw new LocalBackendNotFoundError("Conversation", conversationId);
    }
    return this.ensureConversation(conversationId, agentId);
  }

  listConversations(body?: ConversationListBody): Conversation[] {
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId = optionalString(bodyRecord.agent_id);
    const after = optionalString(bodyRecord.after);
    const limit = typeof bodyRecord.limit === "number" ? bodyRecord.limit : 20;
    let conversations = [...this.conversations.values()].filter(
      (conversation) =>
        conversation.id !== "default" &&
        (!agentId || conversation.agent_id === agentId),
    );
    conversations.sort((a, b) => {
      const aDate = a.last_message_at ?? a.updated_at ?? a.created_at ?? "";
      const bDate = b.last_message_at ?? b.updated_at ?? b.created_at ?? "";
      return bDate.localeCompare(aDate);
    });
    if (after) {
      const afterIndex = conversations.findIndex(
        (conversation) => conversation.id === after,
      );
      if (afterIndex >= 0) conversations = conversations.slice(afterIndex + 1);
    }
    return conversations.slice(0, limit);
  }

  createConversation(body: ConversationCreateBody): Conversation {
    const agentId = body.agent_id ?? this.defaultAgentId;
    if (this.strictAgentAccess && !this.agents.has(agentId)) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    this.ensureAgent(agentId);
    this.conversationSeq += 1;
    const conversation = createLocalConversationRecord(
      `${this.conversationIdPrefix}${this.conversationSeq}`,
      agentId,
      this.conversationSeq,
      body,
    );
    const key = this.conversationKey(conversation.id, agentId);
    this.conversations.set(key, conversation);
    this.localMessagesByConversationKey.set(key, []);
    this.persistConversationState(conversation.id, agentId);
    return conversation;
  }

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Conversation {
    const current = this.findConversation(conversationId);
    if (!current) {
      if (this.strictConversationAccess) {
        throw new LocalBackendNotFoundError("Conversation", conversationId);
      }
      const created = this.ensureConversation(conversationId);
      const updated = updateLocalConversationRecord(
        created,
        body,
        timestampForSequence(this.messageSeq + this.conversationSeq + 1),
      );
      this.conversations.set(
        this.conversationKey(conversationId, created.agent_id),
        updated,
      );
      this.persistConversationState(conversationId, created.agent_id);
      return updated;
    }
    const updated = updateLocalConversationRecord(
      current,
      body,
      timestampForSequence(this.messageSeq + this.conversationSeq + 1),
    );
    this.conversations.set(
      this.conversationKey(conversationId, current.agent_id),
      updated,
    );
    this.persistConversationState(conversationId, current.agent_id);
    return updated;
  }

  forkConversation(
    conversationId: string,
    options: { agentId?: string } = {},
  ): { id: string } {
    const source = this.findConversation(
      conversationId,
      conversationId === "default" ? options.agentId : undefined,
    );
    if (!source) {
      throw new LocalBackendNotFoundError("Conversation", conversationId);
    }
    const targetAgentId = options.agentId ?? source.agent_id;
    if (this.strictAgentAccess && !this.agents.has(targetAgentId)) {
      throw new LocalBackendNotFoundError("Agent", targetAgentId);
    }
    this.ensureAgent(targetAgentId);
    this.conversationSeq += 1;
    const forked = createLocalConversationRecord(
      `${this.conversationIdPrefix}${this.conversationSeq}`,
      targetAgentId,
      this.conversationSeq,
      {
        summary: source.summary ?? null,
        ...(source.model !== undefined ? { model: source.model } : {}),
        ...(source.model_settings !== undefined
          ? { model_settings: source.model_settings }
          : {}),
      } as Partial<ConversationCreateBody>,
    );
    const sourceMessages = this.localMessagesForConversation(
      source.id,
      source.agent_id,
    );
    const forkedMessages = sourceMessages.map((message) =>
      this.cloneLocalMessageForConversation(message, forked.id, targetAgentId),
    );
    forked.in_context_message_ids = forkedMessages.map((message) => message.id);
    const targetKey = this.conversationKey(forked.id, targetAgentId);
    this.conversations.set(targetKey, forked);
    this.localMessagesByConversationKey.set(targetKey, forkedMessages);
    this.persistConversationState(forked.id, targetAgentId);
    return { id: forked.id };
  }

  appendTurnInput(
    conversationId: string,
    body: ConversationMessageCreateBody | ConversationMessageStreamBody,
  ): StoredTurnInput {
    const bodyWithAgent = body as {
      agent_id?: string;
      messages?: Array<Record<string, unknown>>;
    };
    const agentId =
      bodyWithAgent.agent_id ?? this.agentIdForConversation(conversationId);
    if (this.strictAgentAccess && !this.agents.has(agentId)) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    this.ensureAgent(agentId);
    if (
      this.strictConversationAccess &&
      !this.findConversation(conversationId, agentId)
    ) {
      throw new LocalBackendNotFoundError("Conversation", conversationId);
    }
    this.ensureConversation(conversationId, agentId);

    for (const message of bodyWithAgent.messages ?? []) {
      if (message.type === "approval") {
        this.applyApprovalResults(
          conversationId,
          agentId,
          Array.isArray(message.approvals) ? message.approvals : [],
        );
        continue;
      }
      if (message.role === "user") {
        this.appendUserLocalMessage(conversationId, agentId, message);
      }
    }

    return { agentId, conversationId };
  }

  appendStreamChunk(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
  ): LettaStreamingResponse {
    const localUIMessage = getAttachedLocalUIMessage(chunk);
    if (isLocalStateChunkOnly(chunk)) {
      if (localUIMessage) {
        this.applyFinalAssistantUIMessage(
          conversationId,
          agentId,
          localUIMessage,
        );
      }
      return chunk;
    }

    const messageType = (chunk as { message_type?: unknown })?.message_type;
    if (typeof messageType !== "string" || messageType === "stop_reason") {
      return chunk;
    }

    const storedChunk = this.createStoredChunk(
      conversationId,
      agentId,
      toStoredOutputFields(chunk as unknown as Record<string, unknown>),
    );
    this.applyVisibleChunkToLocalMessages(
      conversationId,
      agentId,
      chunk,
      storedChunk,
    );
    return storedChunk as unknown as LettaStreamingResponse;
  }

  listLocalMessages(conversationId: string, agentId?: string): LocalMessage[] {
    const resolvedAgentId =
      agentId ?? this.agentIdForConversation(conversationId);
    this.ensureConversation(conversationId, resolvedAgentId);
    return this.localMessagesForConversation(
      conversationId,
      resolvedAgentId,
    ).map(cloneLocalMessage);
  }

  resolveAgentIdForConversation(conversationId: string): string {
    return this.agentIdForConversation(conversationId);
  }

  getCompiledSystemPrompt(
    conversationId: string,
    agentId: string,
  ): LocalCompiledSystemPrompt | undefined {
    const key = this.conversationKey(conversationId, agentId);
    return this.compiledSystemPromptByConversationKey.get(key);
  }

  setCompiledSystemPrompt(
    conversationId: string,
    agentId: string,
    prompt: LocalCompiledSystemPrompt,
  ): void {
    const conversation = this.ensureConversation(conversationId, agentId);
    const key = this.conversationKey(conversation.id, agentId);
    this.compiledSystemPromptByConversationKey.set(key, prompt);
    this.persistCompiledSystemPrompt(conversation.id, agentId);
  }

  clearCompiledSystemPromptsForAgent(agentId: string): void {
    for (const [key, conversation] of this.conversations.entries()) {
      if (conversation.agent_id !== agentId) continue;
      this.compiledSystemPromptByConversationKey.delete(key);
      if (this.storageDir) {
        rmSync(
          join(
            this.storageDir,
            "conversations",
            encodePathSegment(key),
            "system-prompt.json",
          ),
          { force: true },
        );
      }
    }
  }

  listConversationMessages(
    conversationId: string,
    body?: ConversationMessageListBody,
  ): StoredMessage[] {
    const agentId =
      (body as { agent_id?: string } | undefined)?.agent_id ??
      this.agentIdForConversation(conversationId);
    if (this.strictAgentAccess && !this.agents.has(agentId)) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    const conversation = this.findConversation(conversationId, agentId);
    if (!conversation) {
      if (this.strictConversationAccess) {
        throw new LocalBackendNotFoundError("Conversation", conversationId);
      }
      this.ensureConversation(conversationId, agentId);
    }
    const messages = this.projectedMessagesForConversation(
      conversationId,
      agentId,
    );
    return this.applyListOptions(messages, body);
  }

  listAgentMessages(
    agentId: string,
    body?: AgentMessageListBody,
  ): StoredMessage[] {
    if (this.strictAgentAccess && !this.agents.has(agentId)) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    const conversationId =
      (body as { conversation_id?: string } | undefined)?.conversation_id ??
      "default";
    return this.listConversationMessages(conversationId, {
      ...(body as Record<string, unknown> | undefined),
      agent_id: agentId,
    } as ConversationMessageListBody);
  }

  retrieveMessage(messageId: string): StoredMessage[] {
    this.rebuildMessageIndex();
    const messages = this.messagesById.get(messageId) ?? [];
    if (messages.length === 0 && this.strictConversationAccess) {
      throw new LocalBackendNotFoundError("Message", messageId);
    }
    return [...messages];
  }

  private appendUserLocalMessage(
    conversationId: string,
    agentId: string,
    message: Record<string, unknown>,
  ): LocalMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    const id = this.nextLocalMessageId();
    const date = this.currentLocalMessageDate();
    const localMessage: LocalMessage = {
      id,
      role: "user",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: agentId,
        conversation_id: conversation.id,
      },
      parts: this.localPartsFromInputContent(normalizeContent(message.content)),
    };
    this.pushLocalMessage(conversation.id, agentId, localMessage);
    return localMessage;
  }

  private applyVisibleChunkToLocalMessages(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
    storedChunk: StoredMessage,
  ): void {
    if (chunk.message_type === "reasoning_message") {
      const reasoning = (chunk as { reasoning?: unknown }).reasoning;
      if (typeof reasoning === "string") {
        this.appendAssistantReasoning(
          conversationId,
          agentId,
          reasoning,
          storedChunk,
        );
      }
      return;
    }

    if (chunk.message_type === "assistant_message") {
      const content = (chunk as { content?: unknown }).content;
      const parts = Array.isArray(content)
        ? content
        : textContent(textFromContent(content));
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          this.appendAssistantText(
            conversationId,
            agentId,
            part.text,
            storedChunk,
          );
          continue;
        }
        if (part.type === "reasoning" && typeof part.text === "string") {
          this.appendAssistantReasoning(
            conversationId,
            agentId,
            part.text,
            storedChunk,
          );
        }
      }
      return;
    }

    if (chunk.message_type === "approval_request_message") {
      const toolCall = this.toolCallFromChunk(chunk);
      if (toolCall) {
        this.appendAssistantToolCall(
          conversationId,
          agentId,
          toolCall,
          storedChunk,
        );
      }
    }
  }

  private applyFinalAssistantUIMessage(
    conversationId: string,
    agentId: string,
    message: LocalMessage,
  ): void {
    const conversation = this.ensureConversation(conversationId, agentId);
    const key = this.conversationKey(conversation.id, agentId);
    const localMessages = this.localMessagesByConversationKey.get(key) ?? [];
    const last = localMessages.at(-1);
    const existingAssistant = last?.role === "assistant" ? last : undefined;
    const id = existingAssistant?.id ?? this.nextLocalMessageId();
    const date =
      existingAssistant?.metadata?.created_at ?? this.currentLocalMessageDate();
    const snapshot = cloneLocalMessage(message);
    const localMessage: LocalMessage = {
      ...snapshot,
      id,
      role: "assistant",
      parts: mergeSnapshotPartsWithExistingTools(
        snapshot.parts,
        existingAssistant?.parts ?? [],
      ),
      metadata: {
        ...existingAssistant?.metadata,
        ...snapshot.metadata,
        created_at: date,
        updated_at: date,
        agent_id: agentId,
        conversation_id: conversation.id,
      },
    };
    if (existingAssistant) {
      localMessages[localMessages.length - 1] = localMessage;
    } else {
      localMessages.push(localMessage);
    }
    this.localMessagesByConversationKey.set(key, localMessages);
    this.touchConversationForLocalMessage(
      conversation.id,
      agentId,
      localMessage,
    );
    this.persistConversationState(conversation.id, agentId);
  }

  private appendAssistantText(
    conversationId: string,
    agentId: string,
    text: string,
    storedChunk: StoredMessage,
  ): void {
    const message = this.assistantLocalMessageForAppend(
      conversationId,
      agentId,
      storedChunk,
    );
    const lastPart = message.parts.at(-1);
    if (lastPart?.type === "text") {
      (lastPart as LocalTextPart).text += text;
    } else {
      message.parts.push({ type: "text", text } as LocalMessagePart);
    }
    this.touchLocalMessage(message, storedChunk);
  }

  private appendAssistantReasoning(
    conversationId: string,
    agentId: string,
    text: string,
    storedChunk: StoredMessage,
  ): void {
    const message = this.assistantLocalMessageForAppend(
      conversationId,
      agentId,
      storedChunk,
    );
    const lastPart = message.parts.at(-1);
    if (lastPart?.type === "reasoning") {
      (lastPart as LocalReasoningPart).text += text;
    } else {
      message.parts.push({ type: "reasoning", text } as LocalMessagePart);
    }
    this.touchLocalMessage(message, storedChunk);
  }

  private appendAssistantToolCall(
    conversationId: string,
    agentId: string,
    toolCall: { toolCallId: string; toolName: string; input: unknown },
    storedChunk: StoredMessage,
  ): void {
    const message = this.assistantLocalMessageForAppend(
      conversationId,
      agentId,
      storedChunk,
    );
    const toolPart = {
      type: `tool-${toolCall.toolName}`,
      toolCallId: toolCall.toolCallId,
      state: "approval-requested",
      input: toolCall.input,
      approval: { id: storedChunk.id },
    } as LocalMessagePart;
    const existing = this.findToolPart(
      conversationId,
      agentId,
      toolCall.toolCallId,
    );
    if (existing) {
      Object.assign(existing.part, toolPart);
    } else {
      message.parts.push(toolPart);
    }
    this.touchLocalMessage(message, storedChunk);
  }

  private applyApprovalResults(
    conversationId: string,
    agentId: string,
    approvals: unknown[],
  ): void {
    let touched = false;
    for (const approval of approvals) {
      if (!isRecord(approval)) continue;
      const toolCallId = approval.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      const match = this.findToolPart(conversationId, agentId, toolCallId);
      if (!match) continue;
      if (isSettledLocalToolState((match.part as { state?: unknown }).state)) {
        continue;
      }

      if (approval.type === "approval" && approval.approve === false) {
        delete (match.part as { approval?: unknown }).approval;
        Object.assign(match.part, {
          state: "output-error",
          errorText:
            typeof approval.reason === "string"
              ? approval.reason
              : "Tool execution denied.",
        });
        this.touchLocalMessageForApproval(match.message);
        touched = true;
        continue;
      }

      if (approval.type !== "tool") continue;
      delete (match.part as { approval?: unknown }).approval;
      Object.assign(match.part, {
        state: "output-available",
        output: approval.tool_return,
      });
      this.touchLocalMessageForApproval(match.message);
      touched = true;
    }
    if (touched) {
      this.persistConversationState(conversationId, agentId);
    }
  }

  private findToolPart(
    conversationId: string,
    agentId: string,
    toolCallId: string,
  ): { message: LocalMessage; part: LocalToolPart } | undefined {
    const messages = this.localMessagesForConversation(conversationId, agentId);
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      const message = messages[messageIndex];
      if (!message || message.role !== "assistant") continue;
      for (
        let partIndex = message.parts.length - 1;
        partIndex >= 0;
        partIndex--
      ) {
        const part = message.parts[partIndex];
        if (part && isLocalToolPart(part) && part.toolCallId === toolCallId) {
          return { message, part };
        }
      }
    }
    return undefined;
  }

  private assistantLocalMessageForAppend(
    conversationId: string,
    agentId: string,
    _storedChunk: StoredMessage,
  ): LocalMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    const key = this.conversationKey(conversation.id, agentId);
    const messages = this.localMessagesByConversationKey.get(key) ?? [];
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      return last;
    }

    const id = this.nextLocalMessageId();
    const date = this.currentLocalMessageDate();
    const message: LocalMessage = {
      id,
      role: "assistant",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: agentId,
        conversation_id: conversation.id,
      },
      parts: [],
    };
    messages.push(message);
    this.localMessagesByConversationKey.set(key, messages);
    this.touchConversationForLocalMessage(conversation.id, agentId, message);
    return message;
  }

  private touchLocalMessage(
    message: LocalMessage,
    storedChunk: StoredMessage,
  ): void {
    message.metadata = {
      ...message.metadata,
      updated_at: storedChunk.date,
      agent_id: storedChunk.agent_id,
      conversation_id: storedChunk.conversation_id,
    };
    this.touchConversationForLocalMessage(
      storedChunk.conversation_id,
      storedChunk.agent_id,
      message,
    );
    this.persistConversationState(
      storedChunk.conversation_id,
      storedChunk.agent_id,
    );
  }

  private touchLocalMessageForApproval(message: LocalMessage): void {
    const agentId =
      typeof message.metadata?.agent_id === "string"
        ? message.metadata.agent_id
        : this.defaultAgentId;
    const conversationId =
      typeof message.metadata?.conversation_id === "string"
        ? message.metadata.conversation_id
        : "default";
    const updatedAt = this.nextLocalMessageDate();
    message.metadata = {
      ...message.metadata,
      updated_at: updatedAt,
      agent_id: agentId,
      conversation_id: conversationId,
    };
    this.touchConversationForLocalMessage(conversationId, agentId, message);
  }

  private toolCallFromChunk(
    chunk: LettaStreamingResponse,
  ): { toolCallId: string; toolName: string; input: unknown } | undefined {
    const chunkWithTools = chunk as unknown as {
      tool_call?: unknown;
      tool_calls?: unknown;
    };
    const toolCall =
      (isRecord(chunkWithTools.tool_call) && chunkWithTools.tool_call) ||
      (Array.isArray(chunkWithTools.tool_calls) &&
      isRecord(chunkWithTools.tool_calls[0])
        ? chunkWithTools.tool_calls[0]
        : undefined);
    if (!toolCall) return undefined;
    const toolCallId = toolCall.tool_call_id;
    const toolName = toolCall.name;
    if (typeof toolCallId !== "string" || typeof toolName !== "string") {
      return undefined;
    }
    return {
      toolCallId,
      toolName,
      input: parseToolInput(toolCall.arguments),
    };
  }

  private createStoredChunk(
    conversationId: string,
    agentId: string,
    fields: Record<string, unknown>,
  ): StoredMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    this.messageSeq += 1;
    return {
      id: `${this.storedMessageIdPrefix}${this.messageSeq}`,
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, this.messageSeq)).toISOString(),
      agent_id: agentId,
      conversation_id: conversation.id,
      ...fields,
    } as StoredMessage;
  }

  private applyListOptions(
    messages: StoredMessage[],
    body?: ConversationMessageListBody | AgentMessageListBody,
  ): StoredMessage[] {
    let items = messages;
    const before = getCursor(body, "before");
    if (before) {
      const beforeIndex = items.findIndex((message) => message.id === before);
      if (beforeIndex >= 0) {
        items = items.slice(0, beforeIndex);
      }
    }

    const after = getCursor(body, "after");
    if (after) {
      const afterIndex = items.findIndex((message) => message.id === after);
      if (afterIndex >= 0) {
        items = items.slice(afterIndex + 1);
      }
    }

    if (getListOrder(body) === "desc") {
      items = [...items].reverse();
    } else {
      items = [...items];
    }

    const limit = getListLimit(body);
    return limit === undefined ? items : items.slice(0, limit);
  }

  private projectedMessagesForConversation(
    conversationId: string,
    agentId: string,
  ): StoredMessage[] {
    const key = this.conversationKey(conversationId, agentId);
    const conversation = this.conversations.get(key);
    const resolvedConversationId = conversation?.id ?? conversationId;
    const localMessages = this.localMessagesByConversationKey.get(key) ?? [];
    const messages: StoredMessage[] = [];
    for (let index = 0; index < localMessages.length; index++) {
      const localMessage = localMessages[index];
      if (!localMessage) continue;
      const projected = projectLocalMessageToStoredMessages(
        localMessage,
        agentId,
        resolvedConversationId,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
      );
      messages.push(...projected);
      for (const [lookupKey, lookupMessages] of projectedMessageLookupKeys(
        localMessage,
        projected,
      )) {
        this.messagesById.set(lookupKey, lookupMessages);
      }
    }
    return messages;
  }

  private rebuildMessageIndex(): void {
    this.messagesById.clear();
    for (const conversation of this.conversations.values()) {
      this.projectedMessagesForConversation(
        conversation.id,
        conversation.agent_id,
      );
    }
  }

  private localMessagesForConversation(
    conversationId: string,
    agentId: string,
  ): LocalMessage[] {
    const key = this.conversationKey(conversationId, agentId);
    const messages = this.localMessagesByConversationKey.get(key) ?? [];
    this.localMessagesByConversationKey.set(key, messages);
    return messages;
  }

  private pushLocalMessage(
    conversationId: string,
    agentId: string,
    message: LocalMessage,
  ): void {
    const key = this.conversationKey(conversationId, agentId);
    const messages = this.localMessagesByConversationKey.get(key) ?? [];
    messages.push(message);
    this.localMessagesByConversationKey.set(key, messages);
    this.touchConversationForLocalMessage(conversationId, agentId, message);
    this.persistConversationState(conversationId, agentId);
  }

  private touchConversationForLocalMessage(
    conversationId: string,
    agentId: string,
    message: LocalMessage,
  ): void {
    const key = this.conversationKey(conversationId, agentId);
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    if (!conversation.in_context_message_ids.includes(message.id)) {
      conversation.in_context_message_ids = [
        ...conversation.in_context_message_ids,
        message.id,
      ];
    }
    const date = localMessageDate(
      message,
      new Date(Date.UTC(2026, 0, 1, 0, 0, this.messageSeq + 1)).toISOString(),
    );
    conversation.last_message_at = date;
    conversation.updated_at = date;
    this.conversations.set(key, conversation);
  }

  private cloneLocalMessageForConversation(
    message: LocalMessage,
    conversationId: string,
    agentId: string,
  ): LocalMessage {
    const cloned = cloneLocalMessage(message);
    const date = cloned.metadata?.created_at ?? this.nextLocalMessageDate();
    return {
      ...cloned,
      id: this.nextLocalMessageId(),
      metadata: {
        ...cloned.metadata,
        created_at: date,
        updated_at: cloned.metadata?.updated_at ?? date,
        agent_id: agentId,
        conversation_id: conversationId,
      },
    };
  }

  private localPartsFromInputContent(content: unknown): LocalMessagePart[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return textContent(textFromContent(content));
    const parts: LocalMessagePart[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text } as LocalMessagePart);
        continue;
      }
      parts.push(part as LocalMessagePart);
    }
    return parts.length > 0 ? parts : textContent(textFromContent(content));
  }

  private nextLocalMessageId(): string {
    this.localMessageSeq += 1;
    return `${this.localMessageIdPrefix}${this.localMessageSeq}`;
  }

  private nextLocalMessageDate(): string {
    return timestampForSequence(this.localMessageSeq + 1);
  }

  private currentLocalMessageDate(): string {
    return timestampForSequence(this.localMessageSeq);
  }

  private loadFromStorage(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    const agentsDir = join(this.storageDir, "agents");
    if (existsSync(agentsDir)) {
      for (const file of readdirSync(agentsDir)) {
        if (!file.endsWith(".json")) continue;
        const agent = normalizeAgentRecord(
          readJsonFile<unknown>(join(agentsDir, file)),
          this.defaultAgentModel,
        );
        if (agent?.id) {
          this.agents.set(agent.id, agent);
        }
      }
    }

    const conversationsDir = join(this.storageDir, "conversations");
    if (existsSync(conversationsDir)) {
      for (const conversationDirName of readdirSync(conversationsDir)) {
        const conversationDir = join(conversationsDir, conversationDirName);
        const conversation = readJsonFile<StoredConversation>(
          join(conversationDir, "conversation.json"),
        );
        if (!conversation?.id || !conversation.agent_id) continue;

        const key = this.conversationKey(
          conversation.id,
          conversation.agent_id,
        );
        const localMessages = readJsonlFile<LocalMessage>(
          join(conversationDir, "messages.jsonl"),
        );
        const compiledSystemPrompt = readJsonFile<LocalCompiledSystemPrompt>(
          join(conversationDir, "system-prompt.json"),
        );
        const messages = projectLocalMessagesToStoredMessages(
          localMessages,
          conversation.agent_id,
          conversation.id,
        );

        this.conversations.set(key, conversation);
        this.localMessagesByConversationKey.set(key, localMessages);
        if (compiledSystemPrompt?.content) {
          this.compiledSystemPromptByConversationKey.set(
            key,
            compiledSystemPrompt,
          );
        }
        this.conversationSeq = Math.max(
          this.conversationSeq,
          numericSuffix(conversation.id, this.conversationIdPrefix),
        );

        for (const localMessage of localMessages) {
          this.localMessageSeq = Math.max(
            this.localMessageSeq,
            numericSuffix(localMessage.id, this.localMessageIdPrefix),
          );
        }
        for (const message of messages) {
          this.messagesById.set(message.id, [message]);
          this.messageSeq = Math.max(
            this.messageSeq,
            numericSuffix(message.id, this.storedMessageIdPrefix),
          );
        }
      }
    }
  }

  private persistAgent(agentId: string): void {
    if (!this.storageDir) return;
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const agentsDir = join(this.storageDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, `${encodePathSegment(agentId)}.json`),
      `${JSON.stringify(agent, null, 2)}\n`,
    );
  }

  private projectAgent(record: LocalAgentRecord): AgentState {
    const key = this.conversationKey("default", record.id);
    const defaultMessages = this.projectedMessagesForConversation(
      "default",
      record.id,
    );
    const messageIds = defaultMessages.map((message) => message.id);
    const inContextMessageIds =
      this.conversations.get(key)?.in_context_message_ids ?? messageIds;
    const lastRunCompletion = defaultMessages.at(-1)?.date ?? null;
    return projectAgentState(
      record,
      messageIds,
      inContextMessageIds,
      lastRunCompletion,
    );
  }

  private persistConversationState(
    conversationId: string,
    agentId: string,
  ): void {
    if (!this.storageDir) return;
    const key = this.conversationKey(conversationId, agentId);
    const conversation = this.conversations.get(key);
    if (!conversation) return;

    const conversationDir = join(
      this.storageDir,
      "conversations",
      encodePathSegment(key),
    );
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "conversation.json"),
      `${JSON.stringify(conversation, null, 2)}\n`,
    );
    writeFileSync(
      join(conversationDir, "messages.jsonl"),
      jsonl(this.localMessagesByConversationKey.get(key) ?? []),
    );
    this.persistCompiledSystemPrompt(conversationId, agentId);
  }

  private persistCompiledSystemPrompt(
    conversationId: string,
    agentId: string,
  ): void {
    if (!this.storageDir) return;
    const key = this.conversationKey(conversationId, agentId);
    const prompt = this.compiledSystemPromptByConversationKey.get(key);
    if (!prompt) return;
    const conversationDir = join(
      this.storageDir,
      "conversations",
      encodePathSegment(key),
    );
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, "system-prompt.json"),
      `${JSON.stringify(prompt, null, 2)}\n`,
    );
  }

  private ensureConversation(
    conversationId: string,
    agentId?: string,
  ): StoredConversation {
    const resolvedAgentId = agentId ?? this.defaultAgentId;
    const key = this.conversationKey(conversationId, resolvedAgentId);
    const existing = this.conversations.get(key);
    if (existing) return existing;

    const shouldAdvanceSequence = conversationId !== "default";
    if (shouldAdvanceSequence) {
      this.conversationSeq += 1;
    }
    const conversation = createLocalConversationRecord(
      conversationId,
      resolvedAgentId,
      shouldAdvanceSequence ? this.conversationSeq : this.conversationSeq + 1,
    );
    this.conversations.set(key, conversation);
    this.localMessagesByConversationKey.set(key, []);
    this.persistConversationState(conversation.id, resolvedAgentId);
    return conversation;
  }

  private findConversation(
    conversationId: string,
    agentId?: string,
  ): StoredConversation | undefined {
    if (agentId) {
      return this.conversations.get(
        this.conversationKey(conversationId, agentId),
      );
    }
    if (conversationId === "default") {
      return this.conversations.get(
        this.conversationKey(conversationId, this.defaultAgentId),
      );
    }
    for (const conversation of this.conversations.values()) {
      if (conversation.id === conversationId) return conversation;
    }
    return undefined;
  }

  private agentIdForConversation(conversationId: string): string {
    if (conversationId === "default") return this.defaultAgentId;
    return (
      this.findConversation(conversationId)?.agent_id ?? this.defaultAgentId
    );
  }

  private conversationKey(conversationId: string, agentId: string): string {
    return conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  }
}
