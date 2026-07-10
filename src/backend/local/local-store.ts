import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { LETTA_CODE_SUBAGENT_TAG } from "@/agent/agent-tags";
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
} from "@/backend/backend";
import { INTERRUPTED_BY_USER } from "@/constants";
import { isRecord } from "@/utils/type-guards";
import type { LocalCompactionStats } from "./compaction";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalImageContent,
  type LocalMessage,
  type LocalTextContent,
  type LocalToolCall,
  type LocalToolResultMessage,
  type LocalUserMessage,
} from "./local-message";
import {
  clipOversizedLocalToolResults,
  cloneLocalMessage,
  isLocalToolCallContent,
  mergeSnapshotContentWithExistingToolCalls,
  projectedMessageLookupKeys,
  projectLocalMessageToStoredMessages,
  removeOrphanLocalToolResults,
  withProjectedMessageDates,
} from "./local-message-projection";
import {
  getAttachedLocalMessage,
  isLocalStateChunkOnly,
} from "./local-stream-chunks";
import type { LocalAgentRecord, StoredMessage } from "./local-types";
import type { LocalCompiledSystemPrompt } from "./system-prompt-compilation";
export type { LocalAgentRecord, StoredMessage };

type StoredConversation = Conversation & {
  id: string;
  agent_id: string;
  in_context_message_ids: string[];
  hidden?: boolean;
};

const DEFAULT_LOCAL_AGENT_NAME = "Letta Code";
const DEFAULT_LOCAL_MODEL = "local/default";
const LEGACY_LOCAL_CONTEXT_WINDOW_LIMIT = 128000;
const DEFAULT_LOCAL_CONVERSATION_ID_PREFIX = "local-conv-";
const DEFAULT_LOCAL_STORED_MESSAGE_ID_PREFIX = "letta-msg-";
const DEFAULT_LOCAL_UI_MESSAGE_ID_PREFIX = "ui-msg-";

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function normalizeAgentHiddenFlag(
  hidden: unknown,
  tags: string[],
): boolean | null | undefined {
  if (typeof hidden === "boolean") return hidden;
  if ((hidden === undefined || hidden === null) && isSubagentTags(tags)) {
    return true;
  }
  return hidden === null ? null : undefined;
}

function isSubagentTags(tags: string[]): boolean {
  return tags.includes(LETTA_CODE_SUBAGENT_TAG);
}

export function isHiddenLocalAgentRecord(record: {
  hidden?: boolean | null;
  tags?: unknown;
}): boolean {
  const tags = isStringArray(record.tags) ? record.tags : [];
  return (
    record.hidden === true || (record.hidden == null && isSubagentTags(tags))
  );
}

function shouldPersistSubagentHiddenBackfill(
  raw: unknown,
  record: LocalAgentRecord,
): boolean {
  return (
    isRecord(raw) &&
    (raw.hidden === undefined || raw.hidden === null) &&
    record.hidden === true &&
    isSubagentTags(record.tags)
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
    model_settings: {},
  };
}

function createLocalAgentRecord(
  body: AgentCreateBody,
  defaultAgentName: string,
  defaultAgentModel: string,
): LocalAgentRecord {
  const bodyRecord = body as Record<string, unknown>;
  const tags = isStringArray(bodyRecord.tags) ? bodyRecord.tags : [];
  const hidden = normalizeAgentHiddenFlag(bodyRecord.hidden, tags);
  return {
    id: `agent-local-${randomUUID()}`,
    name: optionalString(bodyRecord.name) ?? defaultAgentName,
    description: optionalStringOrNull(bodyRecord.description) ?? null,
    system: optionalString(bodyRecord.system) ?? "",
    tags,
    model: optionalString(bodyRecord.model) ?? defaultAgentModel,
    model_settings: supportedModelSettingsFromBody(bodyRecord),
    ...(hidden !== undefined ? { hidden } : {}),
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

function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSyntheticLocalTimestamp(value: string | null | undefined): boolean {
  const parsed = parseIsoTimestamp(value);
  if (parsed === null) return false;
  return (
    parsed >= Date.UTC(2026, 0, 1, 0, 0, 0, 0) &&
    parsed < Date.UTC(2026, 0, 2, 0, 0, 0, 0)
  );
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

function supportedConversationModelSettingsFromBody(
  bodyRecord: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const modelSettings = conversationModelSettings(bodyRecord.model_settings);
  if (modelSettings === null) return null;

  const next = modelSettings ?? {};
  if (
    typeof bodyRecord.max_tokens === "number" ||
    bodyRecord.max_tokens === null
  ) {
    next.max_tokens = bodyRecord.max_tokens;
  }

  return Object.keys(next).length > 0 ? next : modelSettings;
}

function createLocalConversationRecord(
  conversationId: string,
  agentId: string,
  _sequence: number,
  body: Partial<ConversationCreateBody> = {},
): StoredConversation {
  const bodyRecord = body as Record<string, unknown>;
  const now = currentIsoTimestamp();
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
      ? { model: bodyRecord.model }
      : {}),
    ...(modelSettings !== undefined ? { model_settings: modelSettings } : {}),
    ...(typeof bodyRecord.context_window_limit === "number"
      ? { context_window_limit: bodyRecord.context_window_limit }
      : {}),
    ...(typeof bodyRecord.hidden === "boolean"
      ? { hidden: bodyRecord.hidden }
      : {}),
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
  const modelSettings = supportedConversationModelSettingsFromBody(bodyRecord);
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

  const compactionSettings = optionalRecordOrNull(value.compaction_settings);
  const tags = isStringArray(value.tags) ? value.tags : [];
  const hidden = normalizeAgentHiddenFlag(value.hidden, tags);
  return {
    id: value.id,
    name: optionalString(value.name) ?? "Letta Code",
    description: optionalStringOrNull(value.description) ?? null,
    system: optionalString(value.system) ?? "",
    tags,
    model:
      optionalString(value.model) ??
      optionalString(legacyLlmConfig.model) ??
      defaultAgentModel,
    model_settings: modelSettings,
    ...(hidden !== undefined ? { hidden } : {}),
    ...(compactionSettings !== undefined
      ? { compaction_settings: compactionSettings }
      : {}),
  };
}

export function projectLocalAgentState(
  record: LocalAgentRecord,
  messageIds: string[] = [],
  inContextMessageIds: string[] = messageIds,
  lastRunCompletion?: string | null,
): AgentState {
  const hidden = normalizeAgentHiddenFlag(record.hidden, record.tags);
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
    ...(hidden !== undefined ? { hidden } : {}),
    ...(record.compaction_settings !== undefined
      ? { compaction_settings: record.compaction_settings }
      : {}),
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

function localImageContentFromLegacyImage(
  part: Record<string, unknown>,
): LocalImageContent | null {
  if (part.type !== "image" || !isRecord(part.source)) return null;
  const source = part.source;
  if (source.type !== "base64") return null;
  const mediaType = source.media_type;
  const data = source.data;
  if (typeof mediaType !== "string" || typeof data !== "string") return null;
  return { type: "image", mimeType: mediaType, data };
}

function normalizeLocalMessageForPi(message: LocalMessage): LocalMessage {
  return message;
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

function sourceLocalMessageIdFromStoredMessageId(messageId: string): string {
  const variantSeparator = messageId.search(/:(assistant|reasoning|tool):/);
  return variantSeparator >= 0
    ? messageId.slice(0, variantSeparator)
    : messageId;
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

export interface LocalCompactionStoreResult {
  numMessagesBefore: number;
  numMessagesAfter: number;
  summaryMessage: LocalMessage;
}

export interface LocalStoreOptions {
  storageDir?: string;
  seedDefaultAgent?: boolean;
  strictAgentAccess?: boolean;
  strictConversationAccess?: boolean;
  defaultAgentName?: string;
  defaultAgentModel?: string;
  defaultAgentModelSettings?: Record<string, unknown>;
  modelSettingsForModel?: (
    model: string,
  ) => Record<string, unknown> | undefined;
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

type LocalContentPart = LocalTextContent | LocalImageContent;
type LocalToolCallContent = LocalToolCall;
function timestampFromIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isoFromTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function encodePathSegment(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function jsonl<T>(items: readonly T[]): string {
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

function readJsonlFileSuffix<T>(
  path: string,
  maxBytes: number,
): { items: T[]; reachedStart: boolean } {
  if (!existsSync(path)) return { items: [], reachedStart: true };
  const size = statSync(path).size;
  if (size === 0) return { items: [], reachedStart: true };

  const bytesToRead = Math.min(size, Math.max(1, maxBytes));
  const start = size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }

  let text = buffer.toString("utf8");
  const reachedStart = start === 0;
  if (!reachedStart) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
  }

  return {
    items: text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T),
    reachedStart,
  };
}

export const LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION = 1;
export const LOCAL_TRANSCRIPT_SCHEMA_VERSION = 2;
export const LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT = "pi-ai-message-jsonl";
export const LOCAL_TRANSCRIPT_MESSAGE_FORMAT = "pi-session-entry-jsonl";
export const LOCAL_TRANSCRIPT_PROVIDER_STACK = "pi-ai";

type LocalTranscriptSchemaVersion =
  | typeof LOCAL_TRANSCRIPT_SCHEMA_VERSION
  | typeof LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION;

type LocalTranscriptMessageFormat =
  | typeof LOCAL_TRANSCRIPT_MESSAGE_FORMAT
  | typeof LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;

export interface LocalTranscriptManifest {
  schema_version: LocalTranscriptSchemaVersion;
  message_format: LocalTranscriptMessageFormat;
  provider_stack: typeof LOCAL_TRANSCRIPT_PROVIDER_STACK;
  created_at: string;
  migrated_from?: string;
  migrated_at?: string;
  backup_path?: string;
}

export class LocalTranscriptMigrationRequiredError extends Error {
  constructor(storageDir: string) {
    const command = localTranscriptMigrationCommand(storageDir);
    super(
      [
        "Local backend found unversioned legacy transcripts that must be converted before use.",
        `Run: ${command}`,
        "The migration creates a backup of each old messages.jsonl before writing the converted transcript.",
      ].join("\n"),
    );
    this.name = "LocalTranscriptMigrationRequiredError";
  }
}

export class LocalTranscriptRepairRequiredError extends Error {
  constructor(storageDir: string, conversationDir: string) {
    const command = localTranscriptMigrationCommand(storageDir);
    super(
      [
        "Local backend found a versioned transcript that still contains legacy UI-message rows.",
        `Transcript: ${conversationDir}`,
        `Run: ${command}`,
        "The migration will back up and repair mismatched messages.jsonl files before startup.",
      ].join("\n"),
    );
    this.name = "LocalTranscriptRepairRequiredError";
  }
}

export function localTranscriptMigrationCommand(storageDir: string): string {
  const quotedStorageDir = `"${storageDir.replace(/"/g, '\\"')}"`;
  return `letta local-backend migrate-transcripts --storage-dir ${quotedStorageDir}`;
}

function transcriptManifestPath(conversationDir: string): string {
  return join(conversationDir, "manifest.json");
}

function transcriptMessagesPath(conversationDir: string): string {
  return join(conversationDir, "messages.jsonl");
}

function hasNonEmptyJsonl(path: string): boolean {
  if (!existsSync(path)) return false;
  const stats = statSync(path);
  if (stats.size === 0) return false;
  const bytesToRead = Math.min(stats.size, 4096);
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(bytesToRead);
  try {
    readSync(fd, buffer, 0, bytesToRead, 0);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8").trim().length > 0 || stats.size > bytesToRead;
}

function isLegacyUiMessageRow(message: unknown): boolean {
  return (
    isRecord(message) &&
    Array.isArray(message.parts) &&
    (!Object.hasOwn(message, "content") || message.content === null)
  );
}

function assertNoLegacyUiMessageRows(
  messages: readonly unknown[],
  storageDir: string,
  conversationDir: string,
): void {
  if (messages.some(isLegacyUiMessageRow)) {
    throw new LocalTranscriptRepairRequiredError(storageDir, conversationDir);
  }
}

interface LocalTranscriptSessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
}

interface LocalTranscriptEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface LocalTranscriptSessionMessageEntry extends LocalTranscriptEntryBase {
  type: "message";
  message: LocalMessage;
}

interface LocalTranscriptCompactionEntry extends LocalTranscriptEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string | null;
  tokensBefore: number;
  message: LocalMessage;
  details?: {
    stats?: LocalCompactionStats;
  };
}

type LocalTranscriptSessionEntry =
  | LocalTranscriptSessionHeader
  | LocalTranscriptSessionMessageEntry
  | LocalTranscriptCompactionEntry;

type LocalTranscriptAppendEntry =
  | LocalTranscriptSessionMessageEntry
  | LocalTranscriptCompactionEntry;

interface LocalTranscriptRowsResult {
  messages: LocalMessage[];
  entryIds: Set<string>;
  entryIdByMessageId: Map<string, string>;
  messageById: Map<string, LocalMessage>;
  lastEntryId: string | null;
  sourceStartIndex: number;
}

function setLatestLocalMessage(
  messagesById: Map<string, LocalMessage>,
  message: LocalMessage,
): void {
  // Map#set does not move an existing key to the insertion tail. Delete first so
  // append-only replacement snapshots preserve latest-message order when a
  // conversation has no explicit in-context id list.
  if (messagesById.has(message.id)) messagesById.delete(message.id);
  messagesById.set(message.id, message);
}

function localMessagesHaveSameSnapshot(
  a: LocalMessage,
  b: LocalMessage,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isLocalTranscriptSessionMessageEntry(
  value: unknown,
): value is LocalTranscriptSessionMessageEntry {
  return (
    isRecord(value) &&
    value.type === "message" &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string" &&
    isRecord(value.message) &&
    typeof value.message.id === "string"
  );
}

function isLocalTranscriptCompactionEntry(
  value: unknown,
): value is LocalTranscriptCompactionEntry {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    typeof value.id === "string" &&
    (value.parentId === null || typeof value.parentId === "string") &&
    typeof value.timestamp === "string" &&
    typeof value.summary === "string" &&
    (value.firstKeptEntryId === null ||
      typeof value.firstKeptEntryId === "string") &&
    typeof value.tokensBefore === "number" &&
    isRecord(value.message) &&
    typeof value.message.id === "string"
  );
}

function isLocalTranscriptAppendEntry(
  value: unknown,
): value is LocalTranscriptAppendEntry {
  return (
    isLocalTranscriptSessionMessageEntry(value) ||
    isLocalTranscriptCompactionEntry(value)
  );
}

function createLocalTranscriptSessionHeader(
  conversation: StoredConversation,
): LocalTranscriptSessionHeader {
  return {
    type: "session",
    version: 3,
    id: conversation.id,
    timestamp: conversation.created_at ?? currentIsoTimestamp(),
    cwd: process.cwd(),
  };
}

function localTranscriptSessionEntries(
  conversation: StoredConversation,
  messages: readonly LocalMessage[],
): LocalTranscriptSessionEntry[] {
  let parentId: string | null = null;
  return [
    createLocalTranscriptSessionHeader(conversation),
    ...messages.map((message) => {
      const entry: LocalTranscriptSessionMessageEntry = {
        type: "message",
        id: randomUUID().slice(0, 8),
        parentId,
        timestamp: localMessageDate(message, currentIsoTimestamp()),
        message,
      };
      parentId = entry.id;
      return entry;
    }),
  ];
}

function localTranscriptRowsResult(
  rows: readonly unknown[],
  messageFormat: LocalTranscriptMessageFormat,
  activeMessageIds: readonly string[] = [],
): LocalTranscriptRowsResult {
  if (messageFormat === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT) {
    const allMessages = rows as LocalMessage[];
    const messageById = new Map<string, LocalMessage>();
    for (const message of allMessages) {
      setLatestLocalMessage(messageById, message);
    }
    const activeMessages = activeMessageIds.length
      ? activeMessageIds
          .map((id) => messageById.get(id))
          .filter((message): message is LocalMessage => message !== undefined)
      : Array.from(messageById.values());
    const firstActiveId = activeMessages[0]?.id;
    return {
      messages: activeMessages,
      entryIds: new Set(allMessages.map((message) => message.id)),
      entryIdByMessageId: new Map(
        allMessages.map((message) => [message.id, message.id] as const),
      ),
      messageById,
      lastEntryId: allMessages.at(-1)?.id ?? null,
      sourceStartIndex: firstActiveId
        ? Math.max(0, activeMessageIds.indexOf(firstActiveId))
        : 0,
    };
  }

  const entryIds = new Set<string>();
  const entryIdByMessageId = new Map<string, string>();
  const allMessages: LocalMessage[] = [];
  const messageById = new Map<string, LocalMessage>();
  let lastEntryId: string | null = null;

  for (const row of rows) {
    if (!isLocalTranscriptAppendEntry(row)) continue;
    entryIds.add(row.id);
    lastEntryId = row.id;
    entryIdByMessageId.set(row.message.id, row.id);
    allMessages.push(row.message);
    setLatestLocalMessage(messageById, row.message);
  }

  const activeMessages = activeMessageIds.length
    ? activeMessageIds
        .map((id) => messageById.get(id))
        .filter((message): message is LocalMessage => message !== undefined)
    : Array.from(messageById.values());
  const firstActiveId = activeMessages[0]?.id;

  return {
    messages: activeMessages,
    entryIds,
    entryIdByMessageId,
    messageById,
    lastEntryId,
    sourceStartIndex: firstActiveId
      ? Math.max(0, activeMessageIds.indexOf(firstActiveId))
      : 0,
  };
}

function createLocalTranscriptManifest(
  input: {
    migratedFrom?: string;
    migratedAt?: string;
    backupPath?: string;
  } = {},
): LocalTranscriptManifest {
  return {
    schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
    message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
    created_at: new Date().toISOString(),
    ...(input.migratedFrom ? { migrated_from: input.migratedFrom } : {}),
    ...(input.migratedAt ? { migrated_at: input.migratedAt } : {}),
    ...(input.backupPath ? { backup_path: input.backupPath } : {}),
  };
}

function validateLocalTranscriptManifest(
  conversationDir: string,
  storageDir: string,
): LocalTranscriptManifest | undefined {
  const manifest = readJsonFile<LocalTranscriptManifest>(
    transcriptManifestPath(conversationDir),
  );
  if (!manifest) {
    if (hasNonEmptyJsonl(transcriptMessagesPath(conversationDir))) {
      throw new LocalTranscriptMigrationRequiredError(storageDir);
    }
    return undefined;
  }
  const isCurrentFormat =
    manifest.schema_version === LOCAL_TRANSCRIPT_SCHEMA_VERSION &&
    manifest.message_format === LOCAL_TRANSCRIPT_MESSAGE_FORMAT;
  const isLegacyFormat =
    manifest.schema_version === LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION &&
    manifest.message_format === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;
  if (
    (!isCurrentFormat && !isLegacyFormat) ||
    manifest.provider_stack !== LOCAL_TRANSCRIPT_PROVIDER_STACK
  ) {
    throw new Error(
      `Unsupported local transcript format in ${conversationDir}. Run ${localTranscriptMigrationCommand(storageDir)} or start a new local conversation.`,
    );
  }
  return manifest;
}

function writeLocalTranscriptManifest(
  conversationDir: string,
  manifest = createLocalTranscriptManifest(),
): void {
  writeFileSync(
    transcriptManifestPath(conversationDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function numericSuffix(value: string, prefix: string): number {
  return value.startsWith(prefix)
    ? Number.parseInt(value.slice(prefix.length), 10) || 0
    : 0;
}

function createdAtForLocalMessage(message: LocalMessage): string | undefined {
  return (
    (typeof message.metadata?.created_at === "string"
      ? message.metadata.created_at
      : undefined) ?? isoFromTimestamp(message.timestamp)
  );
}

function localMessageDate(message: LocalMessage, fallbackDate: string): string {
  return createdAtForLocalMessage(message) ?? fallbackDate;
}

interface LocalTranscriptTiming {
  createdAt?: string;
  updatedAt?: string;
}

interface LocalConversationTranscriptMetadata {
  conversationDir: string;
  messagesPath: string;
  messageFormat: LocalTranscriptMessageFormat;
  manifestValidated: boolean;
  timing: LocalTranscriptTiming;
  requiresFullTimestampRepair: boolean;
}

interface LocalTranscriptPersistOptions {
  transcript?: "append" | "append-compaction" | "rewrite" | "skip";
  message?: LocalMessage;
  compaction?: {
    summaryMessage: LocalMessage;
    summary: string;
    firstKeptMessageId?: string;
    previousMessages?: readonly LocalMessage[];
    stats?: LocalCompactionStats;
  };
}

function fileIsoTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

function transcriptTimingForConversationDir(
  conversationDir: string,
  manifest?: LocalTranscriptManifest,
): LocalTranscriptTiming {
  const messagesPath = transcriptMessagesPath(conversationDir);
  const stats = existsSync(messagesPath) ? statSync(messagesPath) : undefined;
  const manifestCreatedAt =
    parseIsoTimestamp(manifest?.created_at) !== null
      ? manifest?.created_at
      : undefined;
  const fileCreatedAt = fileIsoTimestamp(stats?.birthtimeMs);
  const fileUpdatedAt = fileIsoTimestamp(stats?.mtimeMs);
  return {
    createdAt: manifestCreatedAt ?? fileCreatedAt ?? fileUpdatedAt,
    updatedAt: fileUpdatedAt ?? manifestCreatedAt ?? fileCreatedAt,
  };
}

function interpolatedTranscriptTimestamp(
  timing: LocalTranscriptTiming,
  index: number,
  count: number,
): string | undefined {
  const start =
    parseIsoTimestamp(timing.createdAt) ?? parseIsoTimestamp(timing.updatedAt);
  const end = parseIsoTimestamp(timing.updatedAt) ?? start;
  if (start === null || end === null) return undefined;
  if (count <= 1) return new Date(end).toISOString();

  const boundedEnd = Math.max(start, end);
  const offset = Math.round(((boundedEnd - start) * index) / (count - 1));
  return new Date(start + offset).toISOString();
}

function repairSyntheticLocalMessageTimestamps(
  messages: LocalMessage[],
  timing: LocalTranscriptTiming,
): LocalMessage[] {
  if (
    !messages.some((message) =>
      isSyntheticLocalTimestamp(createdAtForLocalMessage(message)),
    )
  ) {
    return messages;
  }

  return messages.map((message, index) => {
    const currentCreatedAt = createdAtForLocalMessage(message);
    if (!isSyntheticLocalTimestamp(currentCreatedAt)) return message;

    const createdAt = interpolatedTranscriptTimestamp(
      timing,
      index,
      messages.length,
    );
    if (!createdAt) return message;

    const metadata = message.metadata ?? {};
    const updatedAt = isSyntheticLocalTimestamp(metadata.updated_at)
      ? createdAt
      : (metadata.updated_at ?? createdAt);
    return {
      ...message,
      timestamp: timestampFromIso(createdAt),
      metadata: {
        ...metadata,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    };
  });
}

function repairSyntheticConversationTimestamps(
  conversation: StoredConversation,
  messages: LocalMessage[],
  timing: LocalTranscriptTiming,
): StoredConversation {
  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);
  const firstMessageAt = firstMessage
    ? createdAtForLocalMessage(firstMessage)
    : undefined;
  const lastMessageAt = lastMessage
    ? createdAtForLocalMessage(lastMessage)
    : undefined;
  return {
    ...conversation,
    created_at: isSyntheticLocalTimestamp(conversation.created_at)
      ? (firstMessageAt ?? timing.createdAt ?? conversation.created_at)
      : conversation.created_at,
    updated_at: isSyntheticLocalTimestamp(conversation.updated_at)
      ? (lastMessageAt ?? timing.updatedAt ?? conversation.updated_at)
      : conversation.updated_at,
    last_message_at:
      !conversation.last_message_at ||
      isSyntheticLocalTimestamp(conversation.last_message_at)
        ? (lastMessageAt ?? timing.updatedAt ?? conversation.last_message_at)
        : conversation.last_message_at,
  };
}

export class LocalStore {
  private readonly storageDir?: string;
  private readonly strictAgentAccess: boolean;
  private readonly strictConversationAccess: boolean;
  private readonly defaultAgentName: string;
  private readonly defaultAgentModel: string;
  private readonly defaultAgentModelSettings: Record<string, unknown>;
  private readonly modelSettingsForModel?: (
    model: string,
  ) => Record<string, unknown> | undefined;
  private readonly conversationIdPrefix: string;
  private readonly storedMessageIdPrefix: string;
  private readonly localMessageIdPrefix: string;
  private readonly agents = new Map<string, LocalAgentRecord>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly localMessagesByConversationKey = new Map<
    string,
    LocalMessage[]
  >();
  private readonly loadedConversationKeys = new Set<string>();
  private readonly loadRepairedConversationKeys = new Set<string>();
  private readonly transcriptMetadataByConversationKey = new Map<
    string,
    LocalConversationTranscriptMetadata
  >();
  private readonly conversationRecordMtimeMsByKey = new Map<string, number>();
  private readonly sessionEntryIdsByConversationKey = new Map<
    string,
    Set<string>
  >();
  private readonly sessionEntryIdByMessageIdByConversationKey = new Map<
    string,
    Map<string, string>
  >();
  private readonly persistedMessageByMessageIdByConversationKey = new Map<
    string,
    Map<string, LocalMessage>
  >();
  private readonly lastSessionEntryIdByConversationKey = new Map<
    string,
    string | null
  >();
  private readonly compiledSystemPromptByConversationKey = new Map<
    string,
    LocalCompiledSystemPrompt
  >();
  private readonly messagesById = new Map<string, StoredMessage[]>();
  // Tracks local assistant message ids that have received a stop_reason chunk,
  // meaning the turn completed (or was cancelled normally). Used by
  // rollbackUnpersistedTrailingAssistantMessage to distinguish a clean completed
  // turn from one that was cut off before stop_reason.
  private readonly settledLocalMessageIds = new Set<string>();
  private conversationRecordsScanned = false;
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
    this.modelSettingsForModel = options.modelSettingsForModel;
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
    let agents = [...this.agents.values()]
      .filter((agent) => !isHiddenLocalAgentRecord(agent))
      .map((agent) => this.projectAgent(agent));

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
    this.loadConversationRecordsFromStorage();
    for (const [key, conversation] of [...this.conversations.entries()]) {
      if (conversation.agent_id === agentId) {
        this.conversations.delete(key);
        this.localMessagesByConversationKey.delete(key);
        this.loadedConversationKeys.delete(key);
        this.loadRepairedConversationKeys.delete(key);
        this.transcriptMetadataByConversationKey.delete(key);
        this.conversationRecordMtimeMsByKey.delete(key);
        this.sessionEntryIdsByConversationKey.delete(key);
        this.sessionEntryIdByMessageIdByConversationKey.delete(key);
        this.persistedMessageByMessageIdByConversationKey.delete(key);
        this.lastSessionEntryIdByConversationKey.delete(key);
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
    const nextModel =
      typeof requestedModel === "string" &&
      !shouldUseDefaultLocalModel(requestedModel)
        ? requestedModel
        : typeof requestedModel === "string" && this.defaultAgentModel
          ? this.defaultAgentModel
          : undefined;
    const modelChanged =
      nextModel !== undefined && nextModel !== existingRecord.model;
    const nextModelDefaults = nextModel
      ? this.modelSettingsDefaultsForModel(nextModel)
      : undefined;
    const nextModelSettings = {
      ...(modelChanged ? {} : existingRecord.model_settings),
      ...supportedModelSettingsFromBody(bodyRecord),
      ...(modelChanged ? (nextModelDefaults ?? {}) : {}),
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
      ...(nextModel && { model: nextModel }),
      ...(typeof bodyRecord.hidden === "boolean" && {
        hidden: bodyRecord.hidden,
      }),
      model_settings: nextModelSettings,
    };
    this.agents.set(agentId, updated);
    this.persistAgent(agentId);
    if (systemChanged) {
      this.clearCompiledSystemPromptsForAgent(agentId);
    }
    return this.projectAgent(updated);
  }

  setAgentCompactionSettings(
    agentId: string,
    settings: Record<string, unknown> | null,
  ): AgentState {
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new LocalBackendNotFoundError("Agent", agentId);
    }
    const updated: LocalAgentRecord = {
      ...existing,
      compaction_settings: settings === null ? null : { ...settings },
    };
    this.agents.set(agentId, updated);
    this.persistAgent(agentId);
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

  private modelSettingsDefaultsForModel(
    model: string,
  ): Record<string, unknown> | undefined {
    return (
      this.modelSettingsForModel?.(model) ??
      (model === this.defaultAgentModel
        ? this.defaultAgentModelSettings
        : undefined)
    );
  }

  private projectableAgentRecord(record: LocalAgentRecord): LocalAgentRecord {
    const defaults = this.modelSettingsDefaultsForModel(record.model);
    if (!defaults || Object.keys(defaults).length === 0) return record;

    const contextWindowLimit = record.model_settings.context_window_limit;
    const defaultContextWindowLimit = defaults.context_window_limit;
    const shouldReplaceLegacyContextWindow =
      contextWindowLimit === LEGACY_LOCAL_CONTEXT_WINDOW_LIMIT &&
      typeof defaultContextWindowLimit === "number" &&
      defaultContextWindowLimit > LEGACY_LOCAL_CONTEXT_WINDOW_LIMIT;

    return {
      ...record,
      model_settings: {
        ...defaults,
        ...record.model_settings,
        ...(shouldReplaceLegacyContextWindow
          ? { context_window_limit: defaultContextWindowLimit }
          : {}),
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
    this.loadConversationRecordsFromStorage();
    this.refreshLoadedConversationRecordsFromStorage();
    const bodyRecord = (body ?? {}) as Record<string, unknown>;
    const agentId = optionalString(bodyRecord.agent_id);
    const after = optionalString(bodyRecord.after);
    const limit = typeof bodyRecord.limit === "number" ? bodyRecord.limit : 20;
    let conversations = [...this.conversations.values()].filter(
      (conversation) =>
        conversation.id !== "default" &&
        (bodyRecord.include_hidden === true || !conversation.hidden) &&
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
    const conversationId = this.nextConversationId();
    const conversation = createLocalConversationRecord(
      conversationId,
      agentId,
      this.conversationSeq,
      body,
    );
    const key = this.conversationKey(conversation.id, agentId);
    this.conversations.set(key, conversation);
    this.localMessagesByConversationKey.set(key, []);
    this.loadedConversationKeys.add(key);
    this.persistConversationState(conversation.id, agentId);
    return conversation;
  }

  updateConversation(
    conversationId: string,
    body: ConversationUpdateBody,
  ): Conversation {
    if (conversationId === "default") {
      throw new Error("Default conversation cannot be updated");
    }

    const current = this.findConversation(conversationId);
    if (!current) {
      if (this.strictConversationAccess) {
        throw new LocalBackendNotFoundError("Conversation", conversationId);
      }
      const created = this.ensureConversation(conversationId);
      const updated = updateLocalConversationRecord(
        created,
        body,
        currentIsoTimestamp(),
      );
      const projected = this.applyConversationModelDefaults(
        updated,
        body,
        created,
      );
      this.conversations.set(
        this.conversationKey(conversationId, created.agent_id),
        projected,
      );
      this.persistConversationState(conversationId, created.agent_id);
      return projected;
    }
    const updated = this.applyConversationModelDefaults(
      updateLocalConversationRecord(current, body, currentIsoTimestamp()),
      body,
      current,
    );
    this.conversations.set(
      this.conversationKey(conversationId, current.agent_id),
      updated,
    );
    this.persistConversationState(conversationId, current.agent_id);
    return updated;
  }

  private applyConversationModelDefaults(
    conversation: StoredConversation,
    body: ConversationUpdateBody,
    previousConversation: StoredConversation,
  ): StoredConversation {
    const requestedModel = (body as Record<string, unknown>).model;
    if (typeof requestedModel !== "string") return conversation;
    if (previousConversation.model === requestedModel) return conversation;
    const defaults = this.modelSettingsDefaultsForModel(requestedModel);
    if (!defaults || Object.keys(defaults).length === 0) return conversation;
    const existingSettings = isRecord(conversation.model_settings)
      ? conversation.model_settings
      : {};
    return {
      ...conversation,
      model_settings: {
        ...existingSettings,
        ...defaults,
      },
    };
  }

  forkConversation(
    conversationId: string,
    options: { agentId?: string; hidden?: boolean } = {},
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
    const forkedConversationId = this.nextConversationId(targetAgentId);
    const forked = createLocalConversationRecord(
      forkedConversationId,
      targetAgentId,
      this.conversationSeq,
      {
        summary: source.summary ?? null,
        ...(source.model !== undefined ? { model: source.model } : {}),
        ...(source.model_settings !== undefined
          ? { model_settings: source.model_settings }
          : {}),
        ...(typeof options.hidden === "boolean"
          ? { hidden: options.hidden }
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
    this.loadedConversationKeys.add(targetKey);
    this.persistConversationState(forked.id, targetAgentId, {
      transcript: "rewrite",
    });
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
    const localMessageSnapshot = getAttachedLocalMessage(chunk);
    if (isLocalStateChunkOnly(chunk)) {
      if (localMessageSnapshot) {
        this.applyFinalAssistantMessage(
          conversationId,
          agentId,
          localMessageSnapshot,
        );
      }
      return chunk;
    }

    const messageType = (chunk as { message_type?: unknown })?.message_type;
    if (messageType === "stop_reason") {
      this.persistPendingAssistantMessage(conversationId, agentId);
      return chunk;
    }
    if (typeof messageType !== "string") {
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

  settleInterruptedToolCalls(
    conversationIdOrAgentId: string,
    options: { agentId?: string; reason?: string } = {},
  ): number {
    const targets = this.toolSettlementTargets(
      conversationIdOrAgentId,
      options.agentId,
    );
    let settledCount = 0;
    for (const target of targets) {
      settledCount += this.settleInterruptedToolCallsForConversation(
        target.conversationId,
        target.agentId,
        options.reason ?? INTERRUPTED_BY_USER,
      );
    }
    return settledCount;
  }

  resolveAgentIdForConversation(conversationId: string): string {
    return this.agentIdForConversation(conversationId);
  }

  getCompiledSystemPrompt(
    conversationId: string,
    agentId: string,
  ): LocalCompiledSystemPrompt | undefined {
    this.findConversation(conversationId, agentId);
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
    this.loadConversationRecordsFromStorage();
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
    const tailMessages = this.projectTailMessagesForConversation(
      conversationId,
      agentId,
      body,
    );
    if (tailMessages) return tailMessages;

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
    let messages = this.messagesById.get(messageId) ?? [];
    if (messages.length === 0) {
      this.rebuildMessageIndex();
      messages = this.messagesById.get(messageId) ?? [];
    }
    if (messages.length === 0) {
      this.indexMessageFromTranscriptTail(messageId);
      messages = this.messagesById.get(messageId) ?? [];
    }
    if (messages.length === 0) {
      this.loadConversationContainingMessage(messageId);
      messages = this.messagesById.get(messageId) ?? [];
    }
    if (messages.length === 0 && this.strictConversationAccess) {
      throw new LocalBackendNotFoundError("Message", messageId);
    }
    return [...messages];
  }

  compactConversationAll(input: {
    conversationId: string;
    agentId: string;
    summary: string;
    packedSummary: string;
    stats?: LocalCompactionStats;
    remainingMessages?: LocalMessage[];
  }): LocalCompactionStoreResult {
    const conversation = this.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const key = this.conversationKey(conversation.id, input.agentId);
    const previousMessages = this.localMessagesForConversation(
      conversation.id,
      input.agentId,
    );
    const id = this.nextLocalMessageId();
    const date = this.currentLocalMessageDate();
    const summaryMessage: LocalMessage = {
      id,
      role: "user",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: input.agentId,
        conversation_id: conversation.id,
        compaction: {
          summary: input.summary,
          ...(input.stats ? { stats: input.stats } : {}),
        },
      },
      content: [{ type: "text", text: input.packedSummary }],
      timestamp: timestampFromIso(date),
    };
    const compactedMessages = [
      summaryMessage,
      ...(input.remainingMessages ?? []).map(cloneLocalMessage),
    ];
    this.localMessagesByConversationKey.set(key, compactedMessages);
    this.loadedConversationKeys.add(key);
    conversation.in_context_message_ids = compactedMessages.map(
      (message) => message.id,
    );
    conversation.last_message_at = date;
    conversation.updated_at = date;
    this.conversations.set(key, conversation);
    this.persistConversationState(conversation.id, input.agentId, {
      transcript: "append-compaction",
      compaction: {
        summaryMessage,
        summary: input.summary,
        firstKeptMessageId: input.remainingMessages?.[0]?.id,
        previousMessages,
        ...(input.stats ? { stats: input.stats } : {}),
      },
    });
    this.rebuildMessageIndex();
    return {
      numMessagesBefore: previousMessages.length,
      numMessagesAfter: compactedMessages.length,
      summaryMessage: cloneLocalMessage(summaryMessage),
    };
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
      content: this.localContentFromInputContent(
        normalizeContent(message.content),
      ),
      timestamp: timestampFromIso(date),
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

  private applyFinalAssistantMessage(
    conversationId: string,
    agentId: string,
    message: LocalMessage,
  ): void {
    if (message.role !== "assistant") return;
    const conversation = this.ensureConversation(conversationId, agentId);
    const key = this.conversationKey(conversation.id, agentId);
    const localMessages = this.localMessagesForConversation(
      conversation.id,
      agentId,
    );
    const last = localMessages.at(-1);
    const existingAssistant = last?.role === "assistant" ? last : undefined;
    const id = existingAssistant?.id ?? this.nextLocalMessageId();
    const date =
      existingAssistant?.metadata?.created_at ?? this.currentLocalMessageDate();
    const snapshot = cloneLocalMessage(message) as LocalAssistantMessage;
    const localMessage: LocalAssistantMessage = {
      ...snapshot,
      id,
      role: "assistant",
      content: mergeSnapshotContentWithExistingToolCalls(
        snapshot.content,
        existingAssistant?.content ?? [],
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
    this.persistConversationState(conversation.id, agentId, {
      transcript: "append",
      message: localMessage,
    });
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
    const lastContent = message.content.at(-1);
    if (lastContent?.type === "text") {
      lastContent.text += text;
    } else {
      message.content.push({ type: "text", text });
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
    const lastContent = message.content.at(-1);
    if (lastContent?.type === "thinking") {
      lastContent.thinking += text;
    } else {
      message.content.push({ type: "thinking", thinking: text });
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
    const nextToolCall: LocalToolCall = {
      type: "toolCall",
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      arguments: isRecord(toolCall.input)
        ? toolCall.input
        : { input: toolCall.input },
    };
    const existing = this.findToolCall(
      conversationId,
      agentId,
      toolCall.toolCallId,
    );
    if (existing) {
      Object.assign(existing.content, nextToolCall);
    } else {
      message.content.push(nextToolCall);
    }
    this.touchLocalMessage(message, storedChunk);
  }

  private toolResultContentFromUnknown(
    value: unknown,
  ): LocalToolResultMessage["content"] {
    if (Array.isArray(value)) {
      const content: LocalToolResultMessage["content"] = [];
      for (const part of value) {
        if (!isRecord(part)) continue;
        if (part.type === "text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
          continue;
        }
        const image = localImageContentFromLegacyImage(part);
        if (image) content.push(image);
      }
      if (content.length > 0) return content;
    }
    return [{ type: "text", text: textFromContent(value) }];
  }

  private findToolResult(
    conversationId: string,
    agentId: string,
    toolCallId: string,
  ): LocalToolResultMessage | undefined {
    return this.localMessagesForConversation(conversationId, agentId).find(
      (message): message is LocalToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === toolCallId,
    );
  }

  private appendToolResultMessage(input: {
    conversationId: string;
    agentId: string;
    toolCall: LocalToolCall;
    content: LocalToolResultMessage["content"];
    isError: boolean;
  }): void {
    if (
      this.findToolResult(
        input.conversationId,
        input.agentId,
        input.toolCall.id,
      )
    ) {
      return;
    }
    const conversation = this.ensureConversation(
      input.conversationId,
      input.agentId,
    );
    const id = this.nextLocalMessageId();
    const date = this.currentLocalMessageDate();
    const message: LocalToolResultMessage = {
      id,
      role: "toolResult",
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      content: input.content,
      isError: input.isError,
      timestamp: timestampFromIso(date),
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: input.agentId,
        conversation_id: conversation.id,
      },
    };
    this.pushLocalMessage(conversation.id, input.agentId, message);
  }

  private applyApprovalResults(
    conversationId: string,
    agentId: string,
    approvals: unknown[],
  ): void {
    for (const approval of approvals) {
      if (!isRecord(approval)) continue;
      const toolCallId = approval.tool_call_id;
      if (typeof toolCallId !== "string") continue;
      const match = this.findToolCall(conversationId, agentId, toolCallId);
      if (!match) continue;
      if (this.findToolResult(conversationId, agentId, toolCallId)) continue;

      if (approval.type === "approval" && approval.approve === false) {
        this.appendToolResultMessage({
          conversationId,
          agentId,
          toolCall: match.content,
          content: [
            {
              type: "text",
              text:
                typeof approval.reason === "string"
                  ? approval.reason
                  : "Tool execution denied.",
            },
          ],
          isError: true,
        });
        continue;
      }

      if (approval.type !== "tool") continue;
      this.appendToolResultMessage({
        conversationId,
        agentId,
        toolCall: match.content,
        content: this.toolResultContentFromUnknown(approval.tool_return),
        isError: false,
      });
    }
  }

  private settleInterruptedToolCallsForConversation(
    conversationId: string,
    agentId: string,
    reason: string,
  ): number {
    const conversation = this.findConversation(conversationId, agentId);
    if (!conversation) return 0;

    this.rollbackUnpersistedTrailingAssistantMessage(conversation, agentId);

    const messages = this.localMessagesForConversation(
      conversation.id,
      agentId,
    );
    let settledCount = 0;
    for (const message of [...messages]) {
      if (message.role !== "assistant") continue;
      for (const content of message.content) {
        if (!isLocalToolCallContent(content)) continue;
        if (this.findToolResult(conversation.id, agentId, content.id)) continue;
        this.appendToolResultMessage({
          conversationId: conversation.id,
          agentId,
          toolCall: content,
          content: [{ type: "text", text: reason }],
          isError: true,
        });
        settledCount += 1;
      }
    }

    if (settledCount > 0) this.rebuildMessageIndex();
    return settledCount;
  }

  private rollbackUnpersistedTrailingAssistantMessage(
    conversation: StoredConversation,
    agentId: string,
  ): void {
    const key = this.conversationKey(conversation.id, agentId);
    const messages = this.localMessagesForConversation(
      conversation.id,
      agentId,
    );
    const last = messages.at(-1);
    if (last?.role !== "assistant") return;
    // If a stop_reason chunk was received for this message, the turn completed
    // normally — do not roll it back. Works for both disk-backed and in-memory stores.
    if (this.settledLocalMessageIds.has(last.id)) return;
    // For disk-backed stores also check the persisted transcript index as a
    // belt-and-suspenders fallback (covers messages loaded from a previous session).
    if (this.sessionEntryIdsByMessageId(key).has(last.id)) return;

    messages.pop();
    this.localMessagesByConversationKey.set(key, messages);
    conversation.in_context_message_ids =
      conversation.in_context_message_ids.filter((id) => id !== last.id);
    const previousLastMessage = messages.at(-1);
    conversation.last_message_at = previousLastMessage
      ? localMessageDate(
          previousLastMessage,
          conversation.last_message_at ?? currentIsoTimestamp(),
        )
      : conversation.created_at;
    conversation.updated_at = currentIsoTimestamp();
    this.conversations.set(key, conversation);
    this.persistConversationState(conversation.id, agentId, {
      transcript: "skip",
    });
    this.rebuildMessageIndex();
  }

  private findToolCall(
    conversationId: string,
    agentId: string,
    toolCallId: string,
  ):
    | { message: LocalAssistantMessage; content: LocalToolCallContent }
    | undefined {
    const messages = this.localMessagesForConversation(conversationId, agentId);
    for (
      let messageIndex = messages.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      const message = messages[messageIndex];
      if (!message || message.role !== "assistant") continue;
      for (
        let contentIndex = message.content.length - 1;
        contentIndex >= 0;
        contentIndex--
      ) {
        const content = message.content[contentIndex];
        if (
          content &&
          isLocalToolCallContent(content) &&
          content.id === toolCallId
        ) {
          return { message, content };
        }
      }
    }
    return undefined;
  }

  private assistantLocalMessageForAppend(
    conversationId: string,
    agentId: string,
    _storedChunk: StoredMessage,
  ): LocalAssistantMessage {
    const conversation = this.ensureConversation(conversationId, agentId);
    const key = this.conversationKey(conversation.id, agentId);
    const messages = this.localMessagesForConversation(
      conversation.id,
      agentId,
    );
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      return last;
    }

    const id = this.nextLocalMessageId();
    const date = this.currentLocalMessageDate();
    const message: LocalAssistantMessage = {
      id,
      role: "assistant",
      metadata: {
        created_at: date,
        updated_at: date,
        agent_id: agentId,
        conversation_id: conversation.id,
      },
      content: [],
      api: "local",
      provider: "local",
      model: "local",
      usage: emptyLocalUsage(),
      stopReason: "stop",
      timestamp: timestampFromIso(date),
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
      {
        transcript: "skip",
      },
    );
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
      date: currentIsoTimestamp(),
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
    const includedMessageTypes = getIncludedMessageTypes(body);
    if (includedMessageTypes) {
      items = items.filter((message) =>
        includedMessageTypes.has(message.message_type),
      );
    }

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

  private projectLocalMessages(
    localMessages: readonly LocalMessage[],
    agentId: string,
    conversationId: string,
    options: { sourceStartIndex?: number; updateIndex?: boolean } = {},
  ): StoredMessage[] {
    const messages: StoredMessage[] = [];
    const sourceStartIndex = options.sourceStartIndex ?? 0;
    for (let index = 0; index < localMessages.length; index++) {
      const localMessage = localMessages[index];
      if (!localMessage) continue;
      const sourceIndex = sourceStartIndex + index;
      const projected = withProjectedMessageDates(
        projectLocalMessageToStoredMessages(
          localMessage,
          agentId,
          conversationId,
          new Date(Date.UTC(2026, 0, 1, 0, 0, sourceIndex + 1)).toISOString(),
        ),
        sourceIndex,
      );
      messages.push(...projected);
      if (options.updateIndex === false) continue;
      for (const [lookupKey, lookupMessages] of projectedMessageLookupKeys(
        localMessage,
        projected,
      )) {
        this.messagesById.set(lookupKey, lookupMessages);
      }
    }
    return messages;
  }

  private projectTailMessagesForConversation(
    conversationId: string,
    agentId: string,
    body?: ConversationMessageListBody,
  ): StoredMessage[] | undefined {
    const limit = getListLimit(body);
    if (limit === undefined || getListOrder(body) !== "desc") return undefined;
    if (getCursor(body, "after")) return undefined;

    const key = this.conversationKey(conversationId, agentId);
    if (this.loadedConversationKeys.has(key)) return undefined;
    const metadata = this.validateTranscriptMetadata(key);
    if (!metadata || metadata.requiresFullTimestampRepair) return undefined;

    const before = getCursor(body, "before");
    let maxBytes = 64 * 1024;
    for (;;) {
      const tail = readJsonlFileSuffix<unknown>(
        metadata.messagesPath,
        maxBytes,
      );
      const conversation = this.conversations.get(key);
      const transcript = localTranscriptRowsResult(
        tail.items,
        metadata.messageFormat,
        conversation?.in_context_message_ids ?? [],
      );
      assertNoLegacyUiMessageRows(
        transcript.messages,
        this.storageDir ?? "",
        metadata.conversationDir,
      );
      const normalizedMessages = removeOrphanLocalToolResults(
        transcript.messages.map(normalizeLocalMessageForPi),
      ).messages;
      const projected = this.projectLocalMessages(
        normalizedMessages,
        agentId,
        conversationId,
        { sourceStartIndex: transcript.sourceStartIndex },
      );
      const cursorFound =
        !before || projected.some((message) => message.id === before);
      const items = this.applyListOptions(projected, body);
      if (cursorFound && (items.length >= limit || tail.reachedStart)) {
        return items;
      }
      if (tail.reachedStart) return items;
      maxBytes *= 2;
    }
  }

  private projectedMessagesForConversation(
    conversationId: string,
    agentId: string,
  ): StoredMessage[] {
    const key = this.conversationKey(conversationId, agentId);
    const conversation = this.conversations.get(key);
    const resolvedConversationId = conversation?.id ?? conversationId;
    const localMessages = this.localMessagesForConversation(
      resolvedConversationId,
      agentId,
    );
    return this.projectLocalMessages(
      localMessages,
      agentId,
      resolvedConversationId,
    );
  }

  private rebuildMessageIndex(): void {
    this.loadConversationRecordsFromStorage();
    this.messagesById.clear();
    for (const conversation of this.conversations.values()) {
      const key = this.conversationKey(conversation.id, conversation.agent_id);
      if (!this.loadedConversationKeys.has(key)) continue;
      this.projectedMessagesForConversation(
        conversation.id,
        conversation.agent_id,
      );
    }
  }

  private loadConversationContainingMessage(messageId: string): void {
    this.loadConversationRecordsFromStorage();
    const sourceMessageId = sourceLocalMessageIdFromStoredMessageId(messageId);
    for (const conversation of this.conversations.values()) {
      const key = this.conversationKey(conversation.id, conversation.agent_id);
      if (this.loadedConversationKeys.has(key)) continue;
      if (
        !conversation.in_context_message_ids.includes(sourceMessageId) &&
        !conversation.in_context_message_ids.includes(messageId)
      ) {
        continue;
      }
      this.loadConversationMessages(
        key,
        conversation.id,
        conversation.agent_id,
      );
      if ((this.messagesById.get(messageId) ?? []).length > 0) return;
    }

    for (const conversation of this.conversations.values()) {
      const key = this.conversationKey(conversation.id, conversation.agent_id);
      if (this.loadedConversationKeys.has(key)) continue;
      this.loadConversationMessages(
        key,
        conversation.id,
        conversation.agent_id,
      );
      if ((this.messagesById.get(messageId) ?? []).length > 0) return;
    }
  }

  private indexMessageFromTranscriptTail(messageId: string): boolean {
    this.loadConversationRecordsFromStorage();
    const sourceMessageId = sourceLocalMessageIdFromStoredMessageId(messageId);
    for (const conversation of this.conversations.values()) {
      const key = this.conversationKey(conversation.id, conversation.agent_id);
      if (this.loadedConversationKeys.has(key)) continue;
      if (
        !conversation.in_context_message_ids.includes(sourceMessageId) &&
        !conversation.in_context_message_ids.includes(messageId)
      ) {
        continue;
      }
      if (this.indexMessageFromConversationTail(key, conversation, messageId)) {
        return true;
      }
    }
    return false;
  }

  private indexMessageFromConversationTail(
    key: string,
    conversation: StoredConversation,
    messageId: string,
  ): boolean {
    const metadata = this.validateTranscriptMetadata(key);
    if (!metadata || metadata.requiresFullTimestampRepair) return false;

    let maxBytes = 64 * 1024;
    for (;;) {
      const tail = readJsonlFileSuffix<unknown>(
        metadata.messagesPath,
        maxBytes,
      );
      const transcript = localTranscriptRowsResult(
        tail.items,
        metadata.messageFormat,
        conversation.in_context_message_ids,
      );
      assertNoLegacyUiMessageRows(
        transcript.messages,
        this.storageDir ?? "",
        metadata.conversationDir,
      );
      const normalizedMessages = removeOrphanLocalToolResults(
        transcript.messages.map(normalizeLocalMessageForPi),
      ).messages;
      this.projectLocalMessages(
        normalizedMessages,
        conversation.agent_id,
        conversation.id,
        { sourceStartIndex: transcript.sourceStartIndex },
      );
      if ((this.messagesById.get(messageId) ?? []).length > 0) return true;
      if (tail.reachedStart) return false;
      maxBytes *= 2;
    }
  }

  private localMessagesForConversation(
    conversationId: string,
    agentId: string,
  ): LocalMessage[] {
    this.findConversation(conversationId, agentId);
    const key = this.conversationKey(conversationId, agentId);
    if (!this.loadedConversationKeys.has(key)) {
      this.loadConversationMessages(key, conversationId, agentId);
    }
    const messages = this.localMessagesByConversationKey.get(key) ?? [];
    this.localMessagesByConversationKey.set(key, messages);
    this.loadedConversationKeys.add(key);
    return messages;
  }

  private loadConversationMessages(
    key: string,
    conversationId: string,
    agentId: string,
  ): void {
    const metadata = this.validateTranscriptMetadata(key);
    if (!metadata) {
      this.localMessagesByConversationKey.set(
        key,
        this.localMessagesByConversationKey.get(key) ?? [],
      );
      this.loadedConversationKeys.add(key);
      return;
    }

    const rawRows = readJsonlFile<unknown>(metadata.messagesPath);
    const conversation = this.conversations.get(key);
    const transcript = localTranscriptRowsResult(
      rawRows,
      metadata.messageFormat,
      conversation?.in_context_message_ids ?? [],
    );
    assertNoLegacyUiMessageRows(
      transcript.messages,
      this.storageDir ?? "",
      metadata.conversationDir,
    );
    const loadedMessages = repairSyntheticLocalMessageTimestamps(
      transcript.messages.map(normalizeLocalMessageForPi),
      metadata.timing,
    );
    const toolResultRepair = removeOrphanLocalToolResults(loadedMessages);
    const toolResultClip = clipOversizedLocalToolResults(
      toolResultRepair.messages,
    );
    const localMessages = toolResultClip.messages;
    if (toolResultClip.clippedToolResultIds.length > 0) {
      this.loadRepairedConversationKeys.add(key);
    } else {
      this.loadRepairedConversationKeys.delete(key);
    }
    if (conversation) {
      let repairedConversation = repairSyntheticConversationTimestamps(
        conversation,
        localMessages,
        metadata.timing,
      );
      if (toolResultRepair.removedMessageIds.length > 0) {
        const removedMessageIds = new Set(toolResultRepair.removedMessageIds);
        repairedConversation = {
          ...repairedConversation,
          in_context_message_ids:
            repairedConversation.in_context_message_ids.length > 0
              ? repairedConversation.in_context_message_ids.filter(
                  (id) => !removedMessageIds.has(id),
                )
              : localMessages.map((message) => message.id),
        };
      }
      this.conversations.set(key, repairedConversation);
    }
    this.localMessagesByConversationKey.set(key, localMessages);
    this.loadedConversationKeys.add(key);
    this.resetPersistedSessionState(key, metadata.messageFormat, transcript);
    if (conversation && toolResultRepair.removedMessageIds.length > 0) {
      this.persistConversationState(conversation.id, agentId, {
        transcript: "skip",
      });
    }
    for (const message of loadedMessages) {
      this.localMessageSeq = Math.max(
        this.localMessageSeq,
        numericSuffix(message.id, this.localMessageIdPrefix),
      );
    }
    this.projectLocalMessages(localMessages, agentId, conversationId);
  }

  private pushLocalMessage(
    conversationId: string,
    agentId: string,
    message: LocalMessage,
  ): void {
    const messages = this.localMessagesForConversation(conversationId, agentId);
    messages.push(message);
    const key = this.conversationKey(conversationId, agentId);
    this.localMessagesByConversationKey.set(key, messages);
    this.loadedConversationKeys.add(key);
    this.touchConversationForLocalMessage(conversationId, agentId, message);
    this.persistConversationState(conversationId, agentId, {
      transcript: "append",
      message,
    });
  }

  private persistPendingAssistantMessage(
    conversationId: string,
    agentId: string,
  ): void {
    const messages = this.localMessagesForConversation(conversationId, agentId);
    const last = messages.at(-1);
    if (last?.role !== "assistant") {
      this.persistConversationState(conversationId, agentId, {
        transcript: "skip",
      });
      return;
    }
    // Mark as settled regardless of storageDir so rollback detection works for
    // in-memory backends too (persistConversationState is a no-op without storageDir).
    this.settledLocalMessageIds.add(last.id);
    this.persistConversationState(conversationId, agentId, {
      transcript: "append",
      message: last,
    });
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
    const date = localMessageDate(message, currentIsoTimestamp());
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

  private localContentFromInputContent(
    content: unknown,
  ): LocalUserMessage["content"] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (!Array.isArray(content)) return textContent(textFromContent(content));
    const parts: LocalContentPart[] = [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
        continue;
      }
      const imagePart = localImageContentFromLegacyImage(part);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
    return parts.length > 0 ? parts : textContent(textFromContent(content));
  }

  private nextLocalMessageId(): string {
    this.localMessageSeq += 1;
    return `${this.localMessageIdPrefix}${this.localMessageSeq}`;
  }

  private nextLocalMessageDate(): string {
    return currentIsoTimestamp();
  }

  private currentLocalMessageDate(): string {
    return currentIsoTimestamp();
  }

  private setTranscriptMetadata(
    key: string,
    metadata: LocalConversationTranscriptMetadata,
  ): LocalConversationTranscriptMetadata {
    this.transcriptMetadataByConversationKey.set(key, metadata);
    return metadata;
  }

  private transcriptMetadataRecord(
    key: string,
    conversationDir: string,
    options: { requiresFullTimestampRepair?: boolean } = {},
  ): LocalConversationTranscriptMetadata {
    const existing = this.transcriptMetadataByConversationKey.get(key);
    if (existing) return existing;
    return this.setTranscriptMetadata(key, {
      conversationDir,
      messagesPath: transcriptMessagesPath(conversationDir),
      messageFormat: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      manifestValidated: false,
      timing: transcriptTimingForConversationDir(conversationDir),
      requiresFullTimestampRepair: options.requiresFullTimestampRepair === true,
    });
  }

  private validateTranscriptMetadata(
    key: string,
  ): LocalConversationTranscriptMetadata | undefined {
    const metadata = this.transcriptMetadataByConversationKey.get(key);
    if (!metadata) return undefined;
    if (metadata.manifestValidated) return metadata;

    const manifest = validateLocalTranscriptManifest(
      metadata.conversationDir,
      this.storageDir ?? "",
    );
    return this.setTranscriptMetadata(key, {
      ...metadata,
      messageFormat:
        manifest?.message_format ?? LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      manifestValidated: true,
      timing: transcriptTimingForConversationDir(
        metadata.conversationDir,
        manifest,
      ),
    });
  }

  private conversationsDir(): string | undefined {
    return this.storageDir ? join(this.storageDir, "conversations") : undefined;
  }

  private conversationDirForKey(key: string): string | undefined {
    const conversationsDir = this.conversationsDir();
    return conversationsDir
      ? join(conversationsDir, encodePathSegment(key))
      : undefined;
  }

  private updateConversationSequences(conversation: StoredConversation): void {
    this.conversationSeq = Math.max(
      this.conversationSeq,
      numericSuffix(conversation.id, this.conversationIdPrefix),
    );

    for (const messageId of conversation.in_context_message_ids ?? []) {
      this.localMessageSeq = Math.max(
        this.localMessageSeq,
        numericSuffix(messageId, this.localMessageIdPrefix),
      );
    }
  }

  private cacheConversationRecord(
    conversationDir: string,
    input: StoredConversation,
    options: { forceRefresh?: boolean; recordMtimeMs?: number } = {},
  ): StoredConversation {
    const key = this.conversationKey(input.id, input.agent_id);
    const existing = this.conversations.get(key);
    if (existing && options.forceRefresh !== true) return existing;

    const timing = transcriptTimingForConversationDir(conversationDir);
    const requiresFullTimestampRepair =
      isSyntheticLocalTimestamp(input.created_at) ||
      isSyntheticLocalTimestamp(input.updated_at) ||
      isSyntheticLocalTimestamp(input.last_message_at);
    const conversation = requiresFullTimestampRepair
      ? input
      : repairSyntheticConversationTimestamps(input, [], timing);
    let compiledSystemPrompt: LocalCompiledSystemPrompt | undefined;
    try {
      compiledSystemPrompt = readJsonFile<LocalCompiledSystemPrompt>(
        join(conversationDir, "system-prompt.json"),
      );
    } catch {
      compiledSystemPrompt = undefined;
    }

    this.conversations.set(key, conversation);
    this.recordConversationRecordMtime(key, conversationDir, {
      mtimeMs: options.recordMtimeMs,
    });
    this.transcriptMetadataRecord(key, conversationDir, {
      requiresFullTimestampRepair,
    });
    if (compiledSystemPrompt?.content) {
      this.compiledSystemPromptByConversationKey.set(key, compiledSystemPrompt);
    }
    this.updateConversationSequences(conversation);
    return conversation;
  }

  private loadConversationRecordFromDir(
    conversationDir: string,
  ): StoredConversation | undefined {
    try {
      const conversation = readJsonFile<StoredConversation>(
        join(conversationDir, "conversation.json"),
      );
      if (!conversation?.id || !conversation.agent_id) return undefined;
      return this.cacheConversationRecord(conversationDir, conversation);
    } catch {
      return undefined;
    }
  }

  private conversationRecordMtimeMs(
    conversationDir: string,
  ): number | undefined {
    try {
      return statSync(join(conversationDir, "conversation.json")).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private recordConversationRecordMtime(
    key: string,
    conversationDir: string,
    options: { mtimeMs?: number } = {},
  ): void {
    const mtimeMs =
      options.mtimeMs ?? this.conversationRecordMtimeMs(conversationDir);
    if (mtimeMs === undefined) {
      this.conversationRecordMtimeMsByKey.delete(key);
      return;
    }
    this.conversationRecordMtimeMsByKey.set(key, mtimeMs);
  }

  private refreshConversationRecordFromStorage(
    key: string,
  ): StoredConversation | undefined {
    const existing = this.conversations.get(key);
    const metadata = this.transcriptMetadataByConversationKey.get(key);
    const conversationDir =
      metadata?.conversationDir ?? this.conversationDirForKey(key);
    if (!conversationDir) return existing;

    const mtimeMs = this.conversationRecordMtimeMs(conversationDir);
    if (mtimeMs === undefined) return existing;
    if (existing && this.conversationRecordMtimeMsByKey.get(key) === mtimeMs) {
      return existing;
    }

    try {
      const conversation = readJsonFile<StoredConversation>(
        join(conversationDir, "conversation.json"),
      );
      if (!conversation?.id || !conversation.agent_id) return existing;
      const loadedKey = this.conversationKey(
        conversation.id,
        conversation.agent_id,
      );
      if (loadedKey !== key) return existing;
      return this.cacheConversationRecord(conversationDir, conversation, {
        forceRefresh: true,
        recordMtimeMs: mtimeMs,
      });
    } catch {
      return existing;
    }
  }

  private loadConversationRecordsFromStorage(): void {
    if (this.conversationRecordsScanned) return;
    this.conversationRecordsScanned = true;
    const conversationsDir = this.conversationsDir();
    if (!conversationsDir || !existsSync(conversationsDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(conversationsDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const conversationDir = join(conversationsDir, entry);
      try {
        if (!statSync(conversationDir).isDirectory()) continue;
      } catch {
        continue;
      }
      this.loadConversationRecordFromDir(conversationDir);
    }
  }

  private refreshLoadedConversationRecordsFromStorage(): void {
    for (const key of [...this.conversations.keys()]) {
      this.refreshConversationRecordFromStorage(key);
    }
  }

  private loadFromStorage(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) return;

    const agentsDir = join(this.storageDir, "agents");
    if (existsSync(agentsDir)) {
      for (const file of readdirSync(agentsDir)) {
        if (!file.endsWith(".json")) continue;
        const raw = readJsonFile<unknown>(join(agentsDir, file));
        const agent = normalizeAgentRecord(raw, this.defaultAgentModel);
        if (agent?.id) {
          this.agents.set(agent.id, agent);
          if (shouldPersistSubagentHiddenBackfill(raw, agent)) {
            this.persistAgent(agent.id);
          }
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
    const defaultConversation = this.findConversation("default", record.id);
    const messageIds = defaultConversation?.in_context_message_ids ?? [];
    const inContextMessageIds =
      defaultConversation?.in_context_message_ids ?? messageIds;
    const lastRunCompletion =
      defaultConversation?.last_message_at ??
      defaultConversation?.updated_at ??
      null;
    return projectLocalAgentState(
      this.projectableAgentRecord(record),
      messageIds,
      inContextMessageIds,
      lastRunCompletion,
    );
  }

  private persistConversationState(
    conversationId: string,
    agentId: string,
    options: LocalTranscriptPersistOptions = {},
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
    this.recordConversationRecordMtime(key, conversationDir);
    const messagesPath = transcriptMessagesPath(conversationDir);
    let metadata = this.transcriptMetadataRecord(key, conversationDir);
    const manifestPath = transcriptManifestPath(conversationDir);
    if (!existsSync(manifestPath) && !hasNonEmptyJsonl(messagesPath)) {
      const manifest = createLocalTranscriptManifest();
      writeLocalTranscriptManifest(conversationDir, manifest);
      metadata = this.setTranscriptMetadata(key, {
        ...metadata,
        messageFormat: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
        manifestValidated: true,
        timing: transcriptTimingForConversationDir(conversationDir, manifest),
      });
    } else {
      metadata = this.validateTranscriptMetadata(key) ?? metadata;
    }
    const messageFormat = metadata.messageFormat;
    this.persistConversationTranscript(
      key,
      conversation,
      conversationDir,
      messagesPath,
      messageFormat,
      options,
    );
    this.persistCompiledSystemPrompt(conversationId, agentId);
  }

  private persistConversationTranscript(
    key: string,
    conversation: StoredConversation,
    conversationDir: string,
    messagesPath: string,
    messageFormat: LocalTranscriptMessageFormat,
    options: LocalTranscriptPersistOptions,
  ): void {
    if (options.transcript === "skip") return;
    if (
      options.transcript === undefined &&
      this.loadRepairedConversationKeys.has(key) &&
      existsSync(messagesPath)
    ) {
      return;
    }
    const messages = this.localMessagesByConversationKey.get(key) ?? [];
    let activeMessageFormat = messageFormat;
    if (messageFormat === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT) {
      const upgradeMessages = options.compaction?.previousMessages ?? messages;
      if (upgradeMessages.length === 0) return;
      this.rewriteConversationSessionTranscript(
        key,
        conversation,
        messagesPath,
        upgradeMessages,
      );
      const manifest = createLocalTranscriptManifest({
        migratedFrom: "versioned-pi-ai-message-jsonl",
      });
      writeLocalTranscriptManifest(conversationDir, manifest);
      const metadata = this.transcriptMetadataByConversationKey.get(key);
      if (metadata) {
        this.transcriptMetadataByConversationKey.set(key, {
          ...metadata,
          messageFormat: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
          manifestValidated: true,
          timing: transcriptTimingForConversationDir(conversationDir, manifest),
        });
      }
      activeMessageFormat = LOCAL_TRANSCRIPT_MESSAGE_FORMAT;
    }

    if (activeMessageFormat !== LOCAL_TRANSCRIPT_MESSAGE_FORMAT) return;

    if (options.transcript === "append" && options.message) {
      this.appendConversationSessionMessageEntry(
        key,
        conversation,
        messagesPath,
        options.message,
      );
      return;
    }

    if (options.transcript === "append-compaction" && options.compaction) {
      this.appendConversationSessionCompactionEntry(
        key,
        conversation,
        messagesPath,
        options.compaction,
      );
      return;
    }

    if (
      options.transcript === "rewrite" ||
      this.loadedConversationKeys.has(key) ||
      !existsSync(messagesPath)
    ) {
      if (messages.length === 0) return;
      this.rewriteConversationSessionTranscript(
        key,
        conversation,
        messagesPath,
        messages,
      );
      this.loadRepairedConversationKeys.delete(key);
    }
  }

  private rewriteConversationSessionTranscript(
    key: string,
    conversation: StoredConversation,
    messagesPath: string,
    messages: readonly LocalMessage[],
  ): void {
    if (messages.length === 0) return;
    const entries = localTranscriptSessionEntries(conversation, messages);
    writeFileSync(messagesPath, jsonl(entries));
    this.resetPersistedSessionStateFromEntries(key, entries);
  }

  private appendConversationSessionMessageEntry(
    key: string,
    conversation: StoredConversation,
    messagesPath: string,
    message: LocalMessage,
  ): void {
    const entryIdByMessageId = this.sessionEntryIdsByMessageId(key);
    if (entryIdByMessageId.has(message.id)) {
      const persistedMessage = this.persistedMessagesByMessageId(key).get(
        message.id,
      );
      if (
        persistedMessage &&
        localMessagesHaveSameSnapshot(persistedMessage, message)
      ) {
        return;
      }
    }

    this.ensureConversationTranscriptHeader(conversation, messagesPath);
    const parentId = this.lastSessionEntryIdByConversationKey.get(key) ?? null;
    const entry: LocalTranscriptSessionMessageEntry = {
      type: "message",
      id: this.nextSessionEntryId(key),
      parentId,
      timestamp: localMessageDate(message, currentIsoTimestamp()),
      message,
    };
    this.appendConversationSessionEntry(key, messagesPath, entry);
  }

  private appendConversationSessionCompactionEntry(
    key: string,
    conversation: StoredConversation,
    messagesPath: string,
    compaction: NonNullable<LocalTranscriptPersistOptions["compaction"]>,
  ): void {
    const entryIdByMessageId = this.sessionEntryIdsByMessageId(key);
    if (entryIdByMessageId.has(compaction.summaryMessage.id)) return;

    this.ensureConversationTranscriptHeader(conversation, messagesPath);
    const parentId = this.lastSessionEntryIdByConversationKey.get(key) ?? null;
    const entry: LocalTranscriptCompactionEntry = {
      type: "compaction",
      id: this.nextSessionEntryId(key),
      parentId,
      timestamp: localMessageDate(
        compaction.summaryMessage,
        currentIsoTimestamp(),
      ),
      summary: compaction.summary,
      firstKeptEntryId: compaction.firstKeptMessageId
        ? (entryIdByMessageId.get(compaction.firstKeptMessageId) ?? null)
        : null,
      tokensBefore: compaction.stats?.context_tokens_before ?? 0,
      message: compaction.summaryMessage,
      ...(compaction.stats ? { details: { stats: compaction.stats } } : {}),
    };
    this.appendConversationSessionEntry(key, messagesPath, entry);
  }

  private appendConversationSessionEntry(
    key: string,
    messagesPath: string,
    entry: LocalTranscriptAppendEntry,
  ): void {
    appendFileSync(messagesPath, `${JSON.stringify(entry)}\n`);
    this.sessionEntryIds(key).add(entry.id);
    this.sessionEntryIdsByMessageId(key).set(entry.message.id, entry.id);
    this.persistedMessagesByMessageId(key).set(
      entry.message.id,
      cloneLocalMessage(entry.message),
    );
    this.lastSessionEntryIdByConversationKey.set(key, entry.id);
  }

  private ensureConversationTranscriptHeader(
    conversation: StoredConversation,
    messagesPath: string,
  ): void {
    if (existsSync(messagesPath) && statSync(messagesPath).size > 0) return;
    writeFileSync(
      messagesPath,
      `${JSON.stringify(createLocalTranscriptSessionHeader(conversation))}\n`,
    );
  }

  private resetPersistedSessionState(
    key: string,
    messageFormat: LocalTranscriptMessageFormat,
    transcript: LocalTranscriptRowsResult,
  ): void {
    if (messageFormat !== LOCAL_TRANSCRIPT_MESSAGE_FORMAT) return;
    this.sessionEntryIdsByConversationKey.set(key, transcript.entryIds);
    this.sessionEntryIdByMessageIdByConversationKey.set(
      key,
      transcript.entryIdByMessageId,
    );
    this.persistedMessageByMessageIdByConversationKey.set(
      key,
      new Map(
        Array.from(transcript.messageById, ([messageId, message]) => [
          messageId,
          cloneLocalMessage(message),
        ]),
      ),
    );
    this.lastSessionEntryIdByConversationKey.set(key, transcript.lastEntryId);
  }

  private resetPersistedSessionStateFromEntries(
    key: string,
    entries: readonly LocalTranscriptSessionEntry[],
  ): void {
    this.resetPersistedSessionState(
      key,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      localTranscriptRowsResult(entries, LOCAL_TRANSCRIPT_MESSAGE_FORMAT),
    );
  }

  private sessionEntryIds(key: string): Set<string> {
    let entryIds = this.sessionEntryIdsByConversationKey.get(key);
    if (!entryIds) {
      entryIds = new Set<string>();
      this.sessionEntryIdsByConversationKey.set(key, entryIds);
    }
    return entryIds;
  }

  private sessionEntryIdsByMessageId(key: string): Map<string, string> {
    let entryIds = this.sessionEntryIdByMessageIdByConversationKey.get(key);
    if (!entryIds) {
      entryIds = new Map<string, string>();
      this.sessionEntryIdByMessageIdByConversationKey.set(key, entryIds);
    }
    return entryIds;
  }

  private persistedMessagesByMessageId(key: string): Map<string, LocalMessage> {
    let messages = this.persistedMessageByMessageIdByConversationKey.get(key);
    if (!messages) {
      messages = new Map<string, LocalMessage>();
      this.persistedMessageByMessageIdByConversationKey.set(key, messages);
    }
    return messages;
  }

  private nextSessionEntryId(key: string): string {
    const entryIds = this.sessionEntryIds(key);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = randomUUID().slice(0, 8);
      if (!entryIds.has(id)) return id;
    }
    return randomUUID();
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
    const existing = this.findConversation(conversationId, resolvedAgentId);
    if (existing) return existing;

    const key = this.conversationKey(conversationId, resolvedAgentId);

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
    this.loadedConversationKeys.add(key);
    this.persistConversationState(conversation.id, resolvedAgentId);
    return conversation;
  }

  private nextConversationId(agentId?: string): string {
    const resolvedAgentId = agentId ?? this.defaultAgentId;
    for (;;) {
      this.conversationSeq += 1;
      const conversationId = `${this.conversationIdPrefix}${this.conversationSeq}`;
      const key = this.conversationKey(conversationId, resolvedAgentId);
      if (this.conversations.has(key)) continue;
      const conversationDir = this.conversationDirForKey(key);
      if (conversationDir && existsSync(conversationDir)) continue;
      return conversationId;
    }
  }

  private findConversation(
    conversationId: string,
    agentId?: string,
  ): StoredConversation | undefined {
    if (agentId) {
      const key = this.conversationKey(conversationId, agentId);
      const direct = this.refreshConversationRecordFromStorage(key);
      if (direct || conversationId === "default") return direct;
      this.loadConversationRecordsFromStorage();
      return this.refreshConversationRecordFromStorage(key);
    }
    if (conversationId === "default") {
      const key = this.conversationKey(conversationId, this.defaultAgentId);
      return this.refreshConversationRecordFromStorage(key);
    }
    const key = this.conversationKey(conversationId, this.defaultAgentId);
    const direct = this.refreshConversationRecordFromStorage(key);
    if (direct) return direct;
    this.loadConversationRecordsFromStorage();
    return this.refreshConversationRecordFromStorage(key);
  }

  private toolSettlementTargets(
    conversationIdOrAgentId: string,
    agentId?: string,
  ): Array<{ conversationId: string; agentId: string }> {
    if (agentId) {
      const conversation = this.findConversation(
        conversationIdOrAgentId,
        agentId,
      );
      return conversation
        ? [{ conversationId: conversation.id, agentId: conversation.agent_id }]
        : [];
    }

    const conversation = this.findConversation(conversationIdOrAgentId);
    if (conversation) {
      return [
        { conversationId: conversation.id, agentId: conversation.agent_id },
      ];
    }

    if (this.agents.has(conversationIdOrAgentId)) {
      const defaultConversation = this.ensureConversation(
        "default",
        conversationIdOrAgentId,
      );
      return [
        {
          conversationId: defaultConversation.id,
          agentId: defaultConversation.agent_id,
        },
      ];
    }

    return [];
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
