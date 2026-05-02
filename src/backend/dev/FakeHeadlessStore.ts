import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
  AgentMessageListBody,
  AgentUpdateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  ConversationUpdateBody,
} from "../backend";
import type {
  LocalMessage,
  ProviderStreamPart,
  ProviderTrajectoryMessage,
  ProviderTrajectoryUIMessage,
} from "./ProviderTrajectory";
import {
  cloneProviderStreamPart,
  cloneProviderUIMessageSnapshot,
  getAttachedProviderStreamPart,
  getAttachedProviderUIMessage,
  isProviderStreamPartOnly,
} from "./ProviderTrajectory";

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

function createDefaultAgentRecord(agentId: string): LocalAgentRecord {
  return {
    id: agentId,
    name: "Fake Headless Agent",
    description: null,
    system: "",
    tags: [],
    model: "dev/fake-headless",
    model_settings: {
      context_window_limit: 128000,
    },
  };
}

function createLocalAgentRecord(body: AgentCreateBody): LocalAgentRecord {
  const bodyRecord = body as Record<string, unknown>;
  return {
    id: `agent-local-${randomUUID()}`,
    name: optionalString(bodyRecord.name) ?? "Letta Code",
    description: optionalStringOrNull(bodyRecord.description) ?? null,
    system: optionalString(bodyRecord.system) ?? "",
    tags: isStringArray(bodyRecord.tags) ? bodyRecord.tags : [],
    model: optionalString(bodyRecord.model) ?? "dev/fake-headless",
    model_settings: supportedModelSettingsFromBody(bodyRecord),
  };
}

function normalizeAgentRecord(value: unknown): LocalAgentRecord | undefined {
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
      "dev/fake-headless",
    model_settings: modelSettings,
  };
}

function projectAgentState(
  record: LocalAgentRecord,
  messageIds: string[] = [],
  inContextMessageIds: string[] = messageIds,
): AgentState {
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
      ...(typeof record.model_settings.reasoning_effort === "string" && {
        reasoning_effort: record.model_settings.reasoning_effort,
      }),
      ...(typeof record.model_settings.enable_reasoner === "boolean" && {
        enable_reasoner: record.model_settings.enable_reasoner,
      }),
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

function getMessageType(message: Record<string, unknown>): string {
  if (message.type === "approval") {
    return "approval_response_message";
  }
  if (message.role === "assistant") {
    return "assistant_message";
  }
  return "user_message";
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

export interface FakeHeadlessStoreOptions {
  storageDir?: string;
  seedDefaultAgent?: boolean;
  strictAgentAccess?: boolean;
}

export class LocalBackendNotFoundError extends Error {
  readonly status = 404;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
    this.name = "LocalBackendNotFoundError";
  }
}

type ProviderUIMessagePart = ProviderTrajectoryUIMessage["parts"][number];
type ProviderUIToolPart = ProviderUIMessagePart & {
  type: `tool-${string}`;
  toolCallId: string;
};
type ProviderUITextPart = ProviderUIMessagePart & {
  type: "text";
  text: string;
  state?: "streaming" | "done";
  providerMetadata?: unknown;
};
type ProviderUIReasoningPart = ProviderUIMessagePart & {
  type: "reasoning";
  text: string;
  state?: "streaming" | "done";
  providerMetadata?: unknown;
};
type ProviderUIFilePart = ProviderUIMessagePart & {
  type: "file";
};
type ProviderUISourcePart = ProviderUIMessagePart & {
  type: "source-url" | "source-document";
};

function isProviderUIToolPart(
  part: ProviderUIMessagePart,
): part is ProviderUIToolPart {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    "toolCallId" in part &&
    typeof part.toolCallId === "string"
  );
}

function createdAtForLocalMessage(message: LocalMessage): string | undefined {
  return typeof message.metadata?.created_at === "string"
    ? message.metadata.created_at
    : undefined;
}

function agentIdForLocalMessage(message: LocalMessage): string | undefined {
  return typeof message.metadata?.agent_id === "string"
    ? message.metadata.agent_id
    : undefined;
}

function conversationIdForLocalMessage(
  message: LocalMessage,
): string | undefined {
  return typeof message.metadata?.conversation_id === "string"
    ? message.metadata.conversation_id
    : undefined;
}

function localMessageDate(message: LocalMessage, fallbackDate: string): string {
  return createdAtForLocalMessage(message) ?? fallbackDate;
}

function localMessageAgentId(
  message: LocalMessage,
  fallbackAgentId: string,
): string {
  return agentIdForLocalMessage(message) ?? fallbackAgentId;
}

function localMessageConversationId(
  message: LocalMessage,
  fallbackConversationId: string,
): string {
  return conversationIdForLocalMessage(message) ?? fallbackConversationId;
}

function cloneLocalMessage(message: LocalMessage): LocalMessage {
  return cloneProviderUIMessageSnapshot(message) as LocalMessage;
}

function textPartToContentPart(
  part: ProviderUITextPart | ProviderUIReasoningPart,
) {
  return {
    type: part.type,
    text: part.text,
    ...(part.providerMetadata !== undefined && {
      providerMetadata: part.providerMetadata,
    }),
  };
}

function isTextOrReasoningPart(
  part: ProviderUIMessagePart,
): part is ProviderUITextPart | ProviderUIReasoningPart {
  return (
    (part.type === "text" || part.type === "reasoning") &&
    "text" in part &&
    typeof part.text === "string"
  );
}

function isFileOrSourcePart(
  part: ProviderUIMessagePart,
): part is ProviderUIFilePart | ProviderUISourcePart {
  return (
    part.type === "file" ||
    part.type === "source-url" ||
    part.type === "source-document"
  );
}

function localToolName(part: ProviderUIToolPart): string {
  return part.type.slice("tool-".length);
}

function stringifyToolArguments(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function isToolOutputState(state: unknown): boolean {
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

function projectLocalMessageToStoredMessages(
  message: LocalMessage,
  fallbackAgentId: string,
  fallbackConversationId: string,
  fallbackDate: string,
): StoredMessage[] {
  const agentId = localMessageAgentId(message, fallbackAgentId);
  const conversationId = localMessageConversationId(
    message,
    fallbackConversationId,
  );
  const date = localMessageDate(message, fallbackDate);

  if (message.role === "user" || message.role === "system") {
    return [
      {
        id: message.id,
        date,
        agent_id: agentId,
        conversation_id: conversationId,
        message_type: "user_message",
        role: message.role,
        content: message.parts,
      } as StoredMessage,
    ];
  }

  const messages: StoredMessage[] = [];
  const assistantContent: unknown[] = [];

  for (const part of message.parts) {
    if (isTextOrReasoningPart(part)) {
      assistantContent.push(textPartToContentPart(part));
      continue;
    }

    if (isFileOrSourcePart(part)) {
      assistantContent.push(part);
      continue;
    }

    if (!isProviderUIToolPart(part)) continue;
    const toolName = localToolName(part);
    const requestId = `${message.id}:approval:${part.toolCallId}:request`;
    messages.push({
      id: requestId,
      date,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: part.toolCallId,
        name: toolName,
        arguments: stringifyToolArguments((part as { input?: unknown }).input),
      },
    } as StoredMessage);

    if (!isToolOutputState((part as { state?: unknown }).state)) continue;
    const output = (part as { output?: unknown }).output;
    const errorText = (part as { errorText?: unknown }).errorText;
    messages.push({
      id: `${message.id}:approval:${part.toolCallId}:response`,
      date,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "approval_response_message",
      approvals: [
        (part as { state?: unknown }).state === "output-available"
          ? {
              type: "tool",
              tool_call_id: part.toolCallId,
              tool_return: output,
              status: "success",
            }
          : {
              type: "approval",
              tool_call_id: part.toolCallId,
              approve: false,
              reason:
                typeof errorText === "string"
                  ? errorText
                  : "Tool execution denied.",
            },
      ],
      content:
        (part as { state?: unknown }).state === "output-available"
          ? output
          : errorText,
    } as StoredMessage);
  }

  if (assistantContent.length > 0) {
    messages.push({
      id: messages.length > 0 ? `${message.id}:assistant` : message.id,
      date,
      agent_id: agentId,
      conversation_id: conversationId,
      message_type: "assistant_message",
      role: "assistant",
      content: assistantContent,
    } as StoredMessage);
  }

  return messages;
}

function projectLocalMessagesToStoredMessages(
  messages: LocalMessage[],
  fallbackAgentId: string,
  fallbackConversationId: string,
): StoredMessage[] {
  return messages.flatMap((message, index) =>
    projectLocalMessageToStoredMessages(
      message,
      fallbackAgentId,
      fallbackConversationId,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString(),
    ),
  );
}

function localMessageToProviderTrajectoryMessage(
  message: LocalMessage,
  fallbackAgentId: string,
  fallbackConversationId: string,
): ProviderTrajectoryMessage {
  return {
    type: "letta_provider_ui_message",
    schemaVersion: 1,
    id: message.id,
    date:
      createdAtForLocalMessage(message) ??
      new Date(Date.UTC(2026, 0, 1)).toISOString(),
    agentId: localMessageAgentId(message, fallbackAgentId),
    conversationId: localMessageConversationId(message, fallbackConversationId),
    uiMessage: cloneLocalMessage(message),
  };
}

export class FakeHeadlessStore {
  private readonly storageDir?: string;
  private readonly strictAgentAccess: boolean;
  private readonly agents = new Map<string, LocalAgentRecord>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messagesByConversationKey = new Map<
    string,
    StoredMessage[]
  >();
  private readonly providerTrajectoryByConversationKey = new Map<
    string,
    ProviderTrajectoryMessage[]
  >();
  private readonly messagesById = new Map<string, StoredMessage[]>();
  private conversationSeq = 0;
  private messageSeq = 0;
  private providerTrajectorySeq = 0;

  constructor(
    private readonly defaultAgentId: string,
    options: FakeHeadlessStoreOptions = {},
  ) {
    this.storageDir = options.storageDir;
    this.strictAgentAccess = options.strictAgentAccess === true;
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
    const agent = createDefaultAgentRecord(agentId);
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
      createDefaultAgentRecord(agentId);
    const bodyRecord = body as Record<string, unknown>;
    const nextModelSettings = {
      ...existingRecord.model_settings,
      ...supportedModelSettingsFromBody(bodyRecord),
    };
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
      ...(typeof bodyRecord.model === "string" && { model: bodyRecord.model }),
      model_settings: nextModelSettings,
    };
    this.agents.set(agentId, updated);
    this.persistAgent(agentId);
    return this.projectAgent(updated);
  }

  createAgent(body: AgentCreateBody): AgentState {
    const agent = createLocalAgentRecord(body);
    const agentId = agent.id;
    this.agents.set(agentId, agent);
    this.persistAgent(agentId);
    this.ensureConversation("default", agentId);
    return this.projectAgent(agent);
  }

  retrieveConversation(conversationId: string, agentId?: string): Conversation {
    return this.ensureConversation(conversationId, agentId);
  }

  createConversation(body: ConversationCreateBody): Conversation {
    const agentId = body.agent_id ?? this.defaultAgentId;
    this.ensureAgent(agentId);
    this.conversationSeq += 1;
    return this.ensureConversation(
      `conv-fake-headless-${this.conversationSeq}`,
      agentId,
    );
  }

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Conversation {
    const current = this.ensureConversation(conversationId);
    const updated = { ...current, ...(body as Record<string, unknown>) };
    this.conversations.set(
      this.conversationKey(conversationId, current.agent_id),
      updated as StoredConversation,
    );
    this.persistConversationState(conversationId, current.agent_id);
    return updated as Conversation;
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
    this.ensureAgent(agentId);
    this.ensureConversation(conversationId, agentId);

    for (const message of bodyWithAgent.messages ?? []) {
      const storedMessage = this.appendInputMessage(
        conversationId,
        agentId,
        message,
      );
      this.appendProviderInputMessage(
        conversationId,
        agentId,
        message,
        storedMessage,
      );
    }

    return { agentId, conversationId };
  }

  appendStreamChunk(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
  ): LettaStreamingResponse {
    const messageType = (chunk as { message_type?: unknown })?.message_type;
    const providerStreamPart = getAttachedProviderStreamPart(chunk);
    const providerUIMessage = getAttachedProviderUIMessage(chunk);
    if (isProviderStreamPartOnly(chunk)) {
      if (providerStreamPart) {
        this.appendProviderStreamPart(
          conversationId,
          agentId,
          providerStreamPart,
        );
      }
      if (providerUIMessage) {
        this.applyProviderUIMessageSnapshot(
          conversationId,
          agentId,
          providerUIMessage,
        );
      }
      return chunk;
    }

    if (typeof messageType !== "string" || messageType === "stop_reason") {
      if (providerStreamPart) {
        this.appendProviderStreamPart(
          conversationId,
          agentId,
          providerStreamPart,
        );
      }
      return chunk;
    }

    const storedMessage = this.appendMessage(
      conversationId,
      agentId,
      toStoredOutputFields(chunk as unknown as Record<string, unknown>),
    );
    this.appendProviderOutputChunk(
      conversationId,
      agentId,
      chunk,
      storedMessage,
    );
    if (providerStreamPart) {
      this.appendProviderStreamPart(
        conversationId,
        agentId,
        providerStreamPart,
      );
    }
    return storedMessage as unknown as LettaStreamingResponse;
  }

  listProviderTrajectory(
    conversationId: string,
    agentId?: string,
  ): ProviderTrajectoryMessage[] {
    const resolvedAgentId =
      agentId ?? this.agentIdForConversation(conversationId);
    this.ensureConversation(conversationId, resolvedAgentId);
    return [
      ...(this.providerTrajectoryByConversationKey.get(
        this.conversationKey(conversationId, resolvedAgentId),
      ) ?? []),
    ];
  }

  listConversationMessages(
    conversationId: string,
    body?: ConversationMessageListBody,
  ): StoredMessage[] {
    const agentId =
      (body as { agent_id?: string } | undefined)?.agent_id ??
      this.agentIdForConversation(conversationId);
    this.ensureConversation(conversationId, agentId);
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
    return [...(this.messagesById.get(messageId) ?? [])];
  }

  private appendProviderInputMessage(
    conversationId: string,
    agentId: string,
    message: Record<string, unknown>,
    storedMessage: StoredMessage,
  ): void {
    if (message.type === "approval") {
      this.applyApprovalResultsToProviderTrajectory(
        conversationId,
        agentId,
        Array.isArray(message.approvals) ? message.approvals : [],
        storedMessage,
      );
      return;
    }

    if (message.role === "user") {
      const text = textFromContent(normalizeContent(message.content));
      if (text.length > 0) {
        this.appendProviderTrajectoryMessage(conversationId, agentId, {
          storedMessage,
          role: "user",
          parts: [{ type: "text", text }],
        });
      }
    }
  }

  private appendProviderOutputChunk(
    conversationId: string,
    agentId: string,
    chunk: LettaStreamingResponse,
    storedMessage: StoredMessage,
  ): void {
    if (chunk.message_type === "assistant_message") {
      const content = (chunk as { content?: unknown }).content;
      const parts = Array.isArray(content)
        ? content
        : textContent(textFromContent(content));
      for (const part of parts) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          this.appendAssistantTextProviderMessage(
            conversationId,
            agentId,
            part.text,
            storedMessage,
          );
          continue;
        }
        if (part.type === "reasoning" && typeof part.text === "string") {
          this.appendAssistantReasoningProviderMessage(
            conversationId,
            agentId,
            part.text,
            storedMessage,
          );
        }
      }
      return;
    }

    if (chunk.message_type === "approval_request_message") {
      const toolCall = this.toolCallFromChunk(chunk);
      if (toolCall) {
        this.appendAssistantToolCallProviderMessage(
          conversationId,
          agentId,
          toolCall,
          storedMessage,
        );
      }
    }
  }

  private appendProviderTrajectoryMessage(
    conversationId: string,
    agentId: string,
    options: {
      storedMessage?: StoredMessage;
      role: ProviderTrajectoryUIMessage["role"];
      parts: ProviderUIMessagePart[];
    },
  ): ProviderTrajectoryMessage {
    this.providerTrajectorySeq += 1;
    const id = `provider-msg-fake-headless-${this.providerTrajectorySeq}`;
    const date =
      options.storedMessage?.date ??
      new Date(Date.UTC(2026, 0, 1, 0, 0, this.messageSeq + 1)).toISOString();
    const entry: ProviderTrajectoryMessage = {
      type: "letta_provider_ui_message",
      schemaVersion: 1,
      id,
      date,
      agentId,
      conversationId,
      uiMessage: {
        id,
        role: options.role,
        metadata: {
          created_at: date,
          updated_at: date,
          agent_id: agentId,
          conversation_id: conversationId,
        },
        parts: options.parts,
      },
    };
    const key = this.conversationKey(conversationId, agentId);
    const trajectory = this.providerTrajectoryByConversationKey.get(key) ?? [];
    trajectory.push(entry);
    this.providerTrajectoryByConversationKey.set(key, trajectory);
    const conversation = this.conversations.get(key);
    if (conversation && !conversation.in_context_message_ids.includes(id)) {
      conversation.in_context_message_ids = [
        ...conversation.in_context_message_ids,
        id,
      ];
      this.conversations.set(key, conversation);
    }
    this.persistConversationState(conversationId, agentId);
    return entry;
  }

  private appendProviderStreamPart(
    conversationId: string,
    agentId: string,
    part: ProviderStreamPart,
  ): void {
    const entry = this.assistantEntryForProviderStreamPart(
      conversationId,
      agentId,
    );
    const capturedPart = cloneProviderStreamPart(part);
    entry.raw = {
      ...entry.raw,
      streamParts: [...(entry.raw?.streamParts ?? []), capturedPart],
    };
    this.applyProviderRawCapture(entry, capturedPart);
    this.applyProviderStreamPartToUI(conversationId, agentId, entry, part);
    this.persistConversationState(conversationId, agentId);
  }

  private applyProviderUIMessageSnapshot(
    conversationId: string,
    agentId: string,
    message: ProviderTrajectoryUIMessage,
  ): void {
    const entry = this.assistantEntryForProviderStreamPart(
      conversationId,
      agentId,
    );
    const currentMetadata = entry.uiMessage.metadata;
    const snapshot = cloneProviderUIMessageSnapshot(message);
    entry.uiMessage = {
      ...snapshot,
      id: entry.uiMessage.id,
      role: "assistant",
      metadata: {
        ...currentMetadata,
        ...snapshot.metadata,
        created_at:
          currentMetadata?.created_at ?? snapshot.metadata?.created_at,
        updated_at:
          snapshot.metadata?.updated_at ?? currentMetadata?.updated_at,
        agent_id: currentMetadata?.agent_id ?? snapshot.metadata?.agent_id,
        conversation_id:
          currentMetadata?.conversation_id ??
          snapshot.metadata?.conversation_id,
        provider: snapshot.metadata?.provider ?? currentMetadata?.provider,
      },
    };
    this.persistConversationState(conversationId, agentId);
  }

  private applyProviderRawCapture(
    entry: ProviderTrajectoryMessage,
    part: ProviderStreamPart,
  ): void {
    if (!entry.raw) entry.raw = {};

    if (part.type === "start-step") {
      entry.raw.request = part.request;
      entry.raw.warnings = [
        ...(entry.raw.warnings ?? []),
        ...(part.warnings ?? []),
      ];
      entry.raw.steps = [...(entry.raw.steps ?? []), part];
      return;
    }

    if (part.type === "finish-step") {
      entry.raw.response = part.response;
      entry.raw.usage = part.usage;
      entry.raw.providerMetadata = part.providerMetadata;
      entry.raw.steps = [...(entry.raw.steps ?? []), part];
      entry.uiMessage.metadata = {
        ...entry.uiMessage.metadata,
        updated_at: entry.date,
        provider: {
          ...entry.uiMessage.metadata?.provider,
          model_id: part.response.modelId,
          response_id: part.response.id,
          provider_metadata: part.providerMetadata,
          usage: part.usage,
        },
      };
      return;
    }

    if (part.type === "finish") {
      entry.raw.usage = part.totalUsage;
      entry.uiMessage.metadata = {
        ...entry.uiMessage.metadata,
        updated_at: entry.date,
        provider: {
          ...entry.uiMessage.metadata?.provider,
          usage: part.totalUsage,
        },
      };
      return;
    }

    if ("providerMetadata" in part && part.providerMetadata) {
      entry.raw.providerMetadata = part.providerMetadata;
    }
  }

  private applyProviderStreamPartToUI(
    conversationId: string,
    agentId: string,
    entry: ProviderTrajectoryMessage,
    part: ProviderStreamPart,
  ): void {
    if (part.type === "text-start") {
      const textPart = this.ensureTextLikePart(entry, "text");
      textPart.state = "streaming";
      this.applyPartProviderMetadata(textPart, part);
      return;
    }

    if (part.type === "text-delta") {
      const textPart = this.lastTextLikePart(entry, "text");
      if (textPart) this.applyPartProviderMetadata(textPart, part);
      return;
    }

    if (part.type === "text-end") {
      const textPart = this.lastTextLikePart(entry, "text");
      if (textPart) {
        textPart.state = "done";
        this.applyPartProviderMetadata(textPart, part);
      }
      return;
    }

    if (part.type === "reasoning-start") {
      const reasoningPart = this.ensureTextLikePart(entry, "reasoning");
      reasoningPart.state = "streaming";
      this.applyPartProviderMetadata(reasoningPart, part);
      return;
    }

    if (part.type === "reasoning-delta") {
      const reasoningPart = this.lastTextLikePart(entry, "reasoning");
      if (reasoningPart) this.applyPartProviderMetadata(reasoningPart, part);
      return;
    }

    if (part.type === "reasoning-end") {
      const reasoningPart = this.lastTextLikePart(entry, "reasoning");
      if (reasoningPart) {
        reasoningPart.state = "done";
        this.applyPartProviderMetadata(reasoningPart, part);
      }
      return;
    }

    if (part.type === "tool-input-start") {
      const toolPart = this.ensureStreamingToolPart(entry, part);
      this.applyToolCallMetadata(toolPart, part);
      return;
    }

    if (part.type === "tool-input-delta" || part.type === "tool-input-end") {
      const match = this.findToolUIPart(conversationId, agentId, part.id);
      if (match) this.applyToolCallMetadata(match.part, part);
      return;
    }

    if (part.type === "tool-call") {
      const match = this.findToolUIPart(
        conversationId,
        agentId,
        part.toolCallId,
      );
      if (match) this.applyToolCallMetadata(match.part, part);
      return;
    }

    if (part.type === "tool-result") {
      this.applyProviderToolResult(conversationId, agentId, entry, part);
      return;
    }

    if (part.type === "tool-error") {
      this.applyProviderToolError(conversationId, agentId, entry, part);
      return;
    }

    if (part.type === "source") {
      this.appendSourcePart(entry, part);
      return;
    }

    if (part.type === "file") {
      entry.uiMessage.parts.push({
        type: "file",
        mediaType: part.file.mediaType,
        url: `data:${part.file.mediaType};base64,${part.file.base64}`,
        providerMetadata: part.providerMetadata,
      } as ProviderUIMessagePart);
    }
  }

  private assistantEntryForProviderStreamPart(
    conversationId: string,
    agentId: string,
  ): ProviderTrajectoryMessage {
    const trajectory = this.providerTrajectoryForConversation(
      conversationId,
      agentId,
    );
    const last = trajectory.at(-1);
    if (last?.uiMessage.role === "assistant") return last;

    return this.appendProviderTrajectoryMessage(conversationId, agentId, {
      role: "assistant",
      parts: [],
    });
  }

  private ensureTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "text",
  ): ProviderUITextPart;
  private ensureTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "reasoning",
  ): ProviderUIReasoningPart;
  private ensureTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "text" | "reasoning",
  ): ProviderUITextPart | ProviderUIReasoningPart {
    const last =
      type === "text"
        ? this.lastTextLikePart(entry, "text")
        : this.lastTextLikePart(entry, "reasoning");
    if (last) return last;
    const part = { type, text: "" } as
      | ProviderUITextPart
      | ProviderUIReasoningPart;
    entry.uiMessage.parts.push(part as ProviderUIMessagePart);
    return part;
  }

  private lastTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "text",
  ): ProviderUITextPart | undefined;
  private lastTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "reasoning",
  ): ProviderUIReasoningPart | undefined;
  private lastTextLikePart(
    entry: ProviderTrajectoryMessage,
    type: "text" | "reasoning",
  ): ProviderUITextPart | ProviderUIReasoningPart | undefined {
    for (let index = entry.uiMessage.parts.length - 1; index >= 0; index--) {
      const part = entry.uiMessage.parts[index];
      if (part?.type === type) {
        return part as ProviderUITextPart | ProviderUIReasoningPart;
      }
    }
    return undefined;
  }

  private applyPartProviderMetadata(
    uiPart: ProviderUITextPart | ProviderUIReasoningPart,
    streamPart: ProviderStreamPart,
  ): void {
    if ("providerMetadata" in streamPart && streamPart.providerMetadata) {
      uiPart.providerMetadata = streamPart.providerMetadata;
    }
  }

  private ensureStreamingToolPart(
    entry: ProviderTrajectoryMessage,
    part: Extract<ProviderStreamPart, { type: "tool-input-start" }>,
  ): ProviderUIToolPart {
    const existing = entry.uiMessage.parts.find(
      (uiPart): uiPart is ProviderUIToolPart =>
        isProviderUIToolPart(uiPart) && uiPart.toolCallId === part.id,
    );
    if (existing) return existing;
    const toolPart = {
      type: `tool-${part.toolName}`,
      toolCallId: part.id,
      state: "input-streaming",
      input: undefined,
      title: part.title,
      providerExecuted: part.providerExecuted,
    } as ProviderUIToolPart;
    entry.uiMessage.parts.push(toolPart);
    return toolPart;
  }

  private applyToolCallMetadata(
    uiPart: ProviderUIToolPart,
    streamPart: ProviderStreamPart,
  ): void {
    if ("providerMetadata" in streamPart && streamPart.providerMetadata) {
      (uiPart as { callProviderMetadata?: unknown }).callProviderMetadata =
        streamPart.providerMetadata;
    }
    if ("providerExecuted" in streamPart) {
      (uiPart as { providerExecuted?: unknown }).providerExecuted =
        streamPart.providerExecuted;
    }
    if ("title" in streamPart) {
      (uiPart as { title?: unknown }).title = streamPart.title;
    }
  }

  private applyProviderToolResult(
    conversationId: string,
    agentId: string,
    entry: ProviderTrajectoryMessage,
    part: Extract<ProviderStreamPart, { type: "tool-result" }>,
  ): void {
    const match = this.findToolUIPart(conversationId, agentId, part.toolCallId);
    const toolPart = match?.part ?? this.pushToolPart(entry, part);
    Object.assign(toolPart, {
      state: "output-available",
      input: part.input,
      output: part.output,
      preliminary: part.preliminary,
    });
    if (part.providerMetadata) {
      (
        toolPart as { resultProviderMetadata?: unknown }
      ).resultProviderMetadata = part.providerMetadata;
    }
  }

  private applyProviderToolError(
    conversationId: string,
    agentId: string,
    entry: ProviderTrajectoryMessage,
    part: Extract<ProviderStreamPart, { type: "tool-error" }>,
  ): void {
    const match = this.findToolUIPart(conversationId, agentId, part.toolCallId);
    const toolPart = match?.part ?? this.pushToolPart(entry, part);
    Object.assign(toolPart, {
      state: "output-error",
      input: part.input,
      errorText: textFromContent(part.error),
    });
    if (part.providerMetadata) {
      (
        toolPart as { resultProviderMetadata?: unknown }
      ).resultProviderMetadata = part.providerMetadata;
    }
  }

  private pushToolPart(
    entry: ProviderTrajectoryMessage,
    part: Extract<ProviderStreamPart, { toolCallId: string; toolName: string }>,
  ): ProviderUIToolPart {
    const toolPart = {
      type: `tool-${part.toolName}`,
      toolCallId: part.toolCallId,
      input: "input" in part ? part.input : undefined,
    } as ProviderUIToolPart;
    entry.uiMessage.parts.push(toolPart);
    return toolPart;
  }

  private appendSourcePart(
    entry: ProviderTrajectoryMessage,
    part: Extract<ProviderStreamPart, { type: "source" }>,
  ): void {
    if (part.sourceType === "url") {
      entry.uiMessage.parts.push({
        type: "source-url",
        sourceId: part.id,
        url: part.url,
        title: part.title,
        providerMetadata: part.providerMetadata,
      } as ProviderUIMessagePart);
      return;
    }

    entry.uiMessage.parts.push({
      type: "source-document",
      sourceId: part.id,
      mediaType: part.mediaType,
      title: part.title,
      filename: part.filename,
      providerMetadata: part.providerMetadata,
    } as ProviderUIMessagePart);
  }

  private appendAssistantTextProviderMessage(
    conversationId: string,
    agentId: string,
    text: string,
    storedMessage: StoredMessage,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
    );
    const lastPart = entry.uiMessage.parts.at(-1);
    if (lastPart?.type === "text") {
      lastPart.text += text;
    } else {
      entry.uiMessage.parts.push({ type: "text", text });
    }
    this.touchLocalMessageMetadata(entry, storedMessage);
  }

  private appendAssistantReasoningProviderMessage(
    conversationId: string,
    agentId: string,
    text: string,
    storedMessage: StoredMessage,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
    );
    const lastPart = entry.uiMessage.parts.at(-1);
    if (lastPart?.type === "reasoning") {
      lastPart.text += text;
    } else {
      entry.uiMessage.parts.push({ type: "reasoning", text });
    }
    this.touchLocalMessageMetadata(entry, storedMessage);
  }

  private appendAssistantToolCallProviderMessage(
    conversationId: string,
    agentId: string,
    toolCall: { toolCallId: string; toolName: string; input: unknown },
    storedMessage: StoredMessage,
  ): void {
    const entry = this.assistantEntryForAppend(
      conversationId,
      agentId,
      storedMessage,
    );
    const toolPart = {
      type: `tool-${toolCall.toolName}`,
      toolCallId: toolCall.toolCallId,
      state: "approval-requested",
      input: toolCall.input,
      approval: { id: storedMessage.id },
    } as ProviderUIMessagePart;
    const existing = this.findToolUIPart(
      conversationId,
      agentId,
      toolCall.toolCallId,
    );
    if (existing) {
      Object.assign(existing.part, toolPart);
    } else {
      entry.uiMessage.parts.push(toolPart);
    }
    this.touchLocalMessageMetadata(entry, storedMessage);
  }

  private assistantEntryForAppend(
    conversationId: string,
    agentId: string,
    storedMessage: StoredMessage,
  ): ProviderTrajectoryMessage {
    const trajectory = this.providerTrajectoryForConversation(
      conversationId,
      agentId,
    );
    const last = trajectory.at(-1);
    if (last?.uiMessage.role === "assistant") {
      return last;
    }

    return this.appendProviderTrajectoryMessage(conversationId, agentId, {
      storedMessage,
      role: "assistant",
      parts: [],
    });
  }

  private touchLocalMessageMetadata(
    entry: ProviderTrajectoryMessage,
    storedMessage: StoredMessage,
  ): void {
    entry.uiMessage.metadata = {
      ...entry.uiMessage.metadata,
      updated_at: storedMessage.date,
      agent_id: entry.agentId,
      conversation_id: entry.conversationId,
    };
    this.persistConversationState(entry.conversationId, entry.agentId);
  }

  private providerTrajectoryForConversation(
    conversationId: string,
    agentId: string,
  ): ProviderTrajectoryMessage[] {
    const key = this.conversationKey(conversationId, agentId);
    const trajectory = this.providerTrajectoryByConversationKey.get(key) ?? [];
    this.providerTrajectoryByConversationKey.set(key, trajectory);
    return trajectory;
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

  private applyApprovalResultsToProviderTrajectory(
    conversationId: string,
    agentId: string,
    approvals: unknown[],
    storedMessage: StoredMessage,
  ): void {
    for (const approval of approvals) {
      if (!isRecord(approval)) continue;
      const toolCallId = approval.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      const match = this.findToolUIPart(conversationId, agentId, toolCallId);
      if (!match) continue;

      if (approval.type === "approval" && approval.approve === false) {
        delete (match.part as { approval?: unknown }).approval;
        Object.assign(match.part, {
          state: "output-error",
          errorText:
            typeof approval.reason === "string"
              ? approval.reason
              : "Tool execution denied.",
        });
        this.touchLocalMessageMetadata(match.entry, storedMessage);
        continue;
      }

      if (approval.type !== "tool") continue;
      delete (match.part as { approval?: unknown }).approval;
      Object.assign(match.part, {
        state: "output-available",
        output: textFromContent(approval.tool_return),
      });
      this.touchLocalMessageMetadata(match.entry, storedMessage);
    }
  }

  private findToolUIPart(
    conversationId: string,
    agentId: string,
    toolCallId: string,
  ):
    | { entry: ProviderTrajectoryMessage; part: ProviderUIToolPart }
    | undefined {
    const trajectory = this.providerTrajectoryForConversation(
      conversationId,
      agentId,
    );
    for (
      let entryIndex = trajectory.length - 1;
      entryIndex >= 0;
      entryIndex--
    ) {
      const entry = trajectory[entryIndex];
      if (!entry) continue;
      if (entry.uiMessage.role !== "assistant") continue;
      for (
        let partIndex = entry.uiMessage.parts.length - 1;
        partIndex >= 0;
        partIndex--
      ) {
        const part = entry.uiMessage.parts[partIndex];
        if (!part) continue;
        if (isProviderUIToolPart(part) && part.toolCallId === toolCallId) {
          return { entry, part };
        }
      }
    }
    return undefined;
  }

  private appendInputMessage(
    conversationId: string,
    agentId: string,
    message: Record<string, unknown>,
  ): StoredMessage {
    const content =
      message.type === "approval"
        ? (message.approvals ?? [])
        : normalizeContent(message.content);
    return this.appendMessage(conversationId, agentId, {
      message_type: getMessageType(message),
      role: message.role,
      content,
      otid: message.otid,
      approvals: message.approvals,
    });
  }

  private appendMessage(
    conversationId: string,
    agentId: string,
    fields: Record<string, unknown>,
  ): StoredMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    this.messageSeq += 1;
    const id = `msg-fake-headless-${this.messageSeq}`;
    const message = {
      id,
      date: new Date(Date.UTC(2026, 0, 1, 0, 0, this.messageSeq)).toISOString(),
      agent_id: agentId,
      conversation_id: conversation.id,
      ...fields,
    } as StoredMessage;

    const key = this.conversationKey(conversation.id, agentId);
    const messages = this.messagesByConversationKey.get(key) ?? [];
    messages.push(message);
    this.messagesByConversationKey.set(key, messages);
    this.messagesById.set(id, [message]);

    this.ensureAgent(agentId);
    this.persistConversationState(conversation.id, agentId);

    return message;
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
    const localMessages = (
      this.providerTrajectoryByConversationKey.get(key) ?? []
    ).map((entry) => entry.uiMessage);
    const messages = projectLocalMessagesToStoredMessages(
      localMessages,
      agentId,
      conversation?.id ?? conversationId,
    );
    this.messagesByConversationKey.set(key, messages);
    for (const message of messages) {
      this.messagesById.set(message.id, [message]);
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

  private loadFromStorage(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    const agentsDir = join(this.storageDir, "agents");
    if (existsSync(agentsDir)) {
      for (const file of readdirSync(agentsDir)) {
        if (!file.endsWith(".json")) continue;
        const agent = normalizeAgentRecord(
          readJsonFile<unknown>(join(agentsDir, file)),
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
        const providerTrajectory = localMessages.map((message) =>
          localMessageToProviderTrajectoryMessage(
            message,
            conversation.agent_id,
            conversation.id,
          ),
        );
        const messages = projectLocalMessagesToStoredMessages(
          localMessages,
          conversation.agent_id,
          conversation.id,
        );

        this.conversations.set(key, conversation);
        this.messagesByConversationKey.set(key, messages);
        this.providerTrajectoryByConversationKey.set(key, providerTrajectory);
        this.conversationSeq = Math.max(
          this.conversationSeq,
          numericSuffix(conversation.id, "conv-fake-headless-"),
        );

        for (const message of messages) {
          this.messagesById.set(message.id, [message]);
          this.messageSeq = Math.max(
            this.messageSeq,
            numericSuffix(message.id, "msg-fake-headless-"),
          );
        }

        for (const entry of providerTrajectory) {
          this.providerTrajectorySeq = Math.max(
            this.providerTrajectorySeq,
            numericSuffix(entry.id, "provider-msg-fake-headless-"),
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
    return projectAgentState(record, messageIds, inContextMessageIds);
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
      jsonl(
        (this.providerTrajectoryByConversationKey.get(key) ?? []).map(
          (entry) => entry.uiMessage,
        ),
      ),
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

    const conversation = {
      id: conversationId,
      agent_id: resolvedAgentId,
      in_context_message_ids: [],
    } as StoredConversation;
    this.conversations.set(key, conversation);
    this.messagesByConversationKey.set(key, []);
    this.providerTrajectoryByConversationKey.set(key, []);
    this.persistConversationState(conversation.id, resolvedAgentId);
    return conversation;
  }

  private agentIdForConversation(conversationId: string): string {
    if (conversationId === "default") return this.defaultAgentId;
    for (const conversation of this.conversations.values()) {
      if (conversation.id === conversationId) {
        return conversation.agent_id;
      }
    }
    return this.defaultAgentId;
  }

  private conversationKey(conversationId: string, agentId: string): string {
    return conversationId === "default"
      ? `default:${agentId}`
      : `conversation:${conversationId}`;
  }
}
