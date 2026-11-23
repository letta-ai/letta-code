import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import type { LocalCompactionStats, LocalMessage } from "./local-message";
import { removeOrphanLocalToolResults } from "./local-message-projection";
import type { StoredConversation } from "./local-types";

export const LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION = 1;
export const LOCAL_TRANSCRIPT_SCHEMA_VERSION = 2;
export const LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT = "pi-ai-message-jsonl";
export const LOCAL_TRANSCRIPT_MESSAGE_FORMAT = "pi-session-entry-jsonl";
export const LOCAL_TRANSCRIPT_PROVIDER_STACK = "pi-ai";
export const LOCAL_TRANSCRIPT_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const LOCAL_TRANSCRIPT_BYTES_PER_CONTEXT_TOKEN = 8;
const LEGACY_LOCAL_CONTEXT_WINDOW_LIMIT = 128000;

type LocalTranscriptSchemaVersion =
  | typeof LOCAL_TRANSCRIPT_SCHEMA_VERSION
  | typeof LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION;

export type LocalTranscriptMessageFormat =
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

export function transcriptManifestPath(conversationDir: string): string {
  return join(conversationDir, "manifest.json");
}

export function transcriptMessagesPath(conversationDir: string): string {
  return join(conversationDir, "messages.jsonl");
}

export function hasNonEmptyJsonl(path: string): boolean {
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

export function assertNoLegacyUiMessageRows(
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

export interface LocalTranscriptSessionMessageEntry
  extends LocalTranscriptEntryBase {
  type: "message";
  message: LocalMessage;
}

export interface LocalTranscriptCompactionEntry
  extends LocalTranscriptEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string | null;
  tokensBefore: number;
  message: LocalMessage;
  details?: {
    stats?: LocalCompactionStats;
  };
}

export type LocalTranscriptSessionEntry =
  | LocalTranscriptSessionHeader
  | LocalTranscriptSessionMessageEntry
  | LocalTranscriptCompactionEntry;

export type LocalTranscriptAppendEntry =
  | LocalTranscriptSessionMessageEntry
  | LocalTranscriptCompactionEntry;

export interface LocalTranscriptRowsResult {
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
  if (messagesById.has(message.id)) messagesById.delete(message.id);
  messagesById.set(message.id, message);
}

export function localMessagesHaveSameSnapshot(
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

export function isLocalTranscriptAppendEntry(
  value: unknown,
): value is LocalTranscriptAppendEntry {
  return (
    isLocalTranscriptSessionMessageEntry(value) ||
    isLocalTranscriptCompactionEntry(value)
  );
}

function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

export function createLocalTranscriptSessionHeader(
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

export function localTranscriptSessionEntries(
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

export function localTranscriptRowsResult(
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

export function createLocalTranscriptManifest(
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

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function readJsonlFile<T>(path: string): T[] {
  const items: T[] = [];
  forEachJsonlRow<T>(path, (item) => {
    items.push(item);
  });
  return items;
}

export function forEachJsonlRow<T>(
  path: string,
  onRow: (item: T) => void,
): void {
  if (!existsSync(path)) return;

  const buffer = Buffer.alloc(64 * 1024);
  const pending: Buffer[] = [];
  const fd = openSync(path, "r");
  try {
    let bytesRead = 0;
    do {
      bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const suffix = buffer.subarray(lineStart, index);
        const line = pending.length
          ? Buffer.concat([...pending, suffix])
          : suffix;
        pending.length = 0;
        const text = line.toString("utf8");
        if (text.trim().length > 0) onRow(JSON.parse(text) as T);
        lineStart = index + 1;
      }
      if (lineStart < bytesRead) {
        pending.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
      }
    } while (bytesRead > 0);
  } finally {
    closeSync(fd);
  }

  if (pending.length > 0) {
    const text = Buffer.concat(pending).toString("utf8");
    if (text.trim().length > 0) onRow(JSON.parse(text) as T);
  }
}

export function readJsonlFileSuffix<T>(
  path: string,
  maxBytes: number,
): {
  items: T[];
  reachedStart: boolean;
  startOffset: number;
  bytesRead: number;
} {
  if (!existsSync(path))
    return { items: [], reachedStart: true, startOffset: 0, bytesRead: 0 };
  const size = statSync(path).size;
  if (size === 0)
    return { items: [], reachedStart: true, startOffset: 0, bytesRead: 0 };

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
  const firstNewlineByte = reachedStart ? -1 : buffer.indexOf(0x0a);

  return {
    items: text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T),
    reachedStart,
    bytesRead: bytesToRead,
    startOffset: reachedStart
      ? 0
      : firstNewlineByte >= 0
        ? start + firstNewlineByte + 1
        : size,
  };
}

export function jsonl<T>(items: readonly T[]): string {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

export function validateLocalTranscriptManifest(
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

export function writeLocalTranscriptManifest(
  conversationDir: string,
  manifest = createLocalTranscriptManifest(),
): void {
  writeFileSync(
    transcriptManifestPath(conversationDir),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSyntheticLocalTimestamp(
  value: string | null | undefined,
): boolean {
  const parsed = parseIsoTimestamp(value);
  if (parsed === null) return false;
  return (
    parsed >= Date.UTC(2026, 0, 1, 0, 0, 0, 0) &&
    parsed < Date.UTC(2026, 0, 2, 0, 0, 0, 0)
  );
}

export function timestampFromIso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isoFromTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

export function createdAtForLocalMessage(
  message: LocalMessage,
): string | undefined {
  return (
    (typeof message.metadata?.created_at === "string"
      ? message.metadata.created_at
      : undefined) ?? isoFromTimestamp(message.timestamp)
  );
}

export function localMessageDate(
  message: LocalMessage,
  fallbackDate: string,
): string {
  return createdAtForLocalMessage(message) ?? fallbackDate;
}

export interface LocalTranscriptTiming {
  createdAt?: string;
  updatedAt?: string;
}

function fileIsoTimestamp(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

export function transcriptTimingForConversationDir(
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

export function repairSyntheticLocalMessageTimestamps(
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

export function repairSyntheticConversationTimestamps(
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

export function normalizeLocalMessageForPi(
  message: LocalMessage,
): LocalMessage {
  return message;
}

export interface LocalTranscriptTailReadResult {
  transcript: LocalTranscriptRowsResult;
  messages: LocalMessage[];
}

export function localTranscriptTailByteBudget(
  conversation: unknown,
  agentSettings: unknown,
): number {
  const conversationRecord = isRecord(conversation) ? conversation : {};
  const conversationSettings = isRecord(conversationRecord.model_settings)
    ? conversationRecord.model_settings
    : {};
  const agentSettingsRecord = isRecord(agentSettings) ? agentSettings : {};
  const contextWindow = [
    conversationRecord.context_window_limit,
    conversationSettings.context_window_limit,
    agentSettingsRecord.context_window_limit,
  ].find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return (
    (contextWindow ?? LEGACY_LOCAL_CONTEXT_WINDOW_LIMIT) *
    LOCAL_TRANSCRIPT_BYTES_PER_CONTEXT_TOKEN
  );
}

export function localTranscriptTailMessages(
  rows: readonly unknown[],
  messageFormat: LocalTranscriptMessageFormat,
  activeMessageIds: readonly string[],
  storageDir: string,
  conversationDir: string,
): LocalTranscriptTailReadResult {
  const transcript = localTranscriptRowsResult(
    rows,
    messageFormat,
    activeMessageIds,
  );
  assertNoLegacyUiMessageRows(transcript.messages, storageDir, conversationDir);
  const messages = removeOrphanLocalToolResults(
    transcript.messages.map(normalizeLocalMessageForPi),
  ).messages;
  return { transcript, messages };
}

export function readLocalTranscriptTailWindow(
  messagesPath: string,
  messageFormat: LocalTranscriptMessageFormat,
  activeMessageIds: readonly string[],
  minMessages: number,
  storageDir: string,
  conversationDir: string,
  maxTailBytes = LOCAL_TRANSCRIPT_TAIL_MAX_BYTES,
): LocalTranscriptTailReadResult & {
  reachedStart: boolean;
  headBytes: number;
  bytesRead: number;
  liveInContextIds: string[];
} {
  const targetCount =
    activeMessageIds.length > 0 ? activeMessageIds.length : minMessages;
  const byteBudget = Math.max(64 * 1024, Math.floor(maxTailBytes));
  let maxBytes = 64 * 1024;
  for (;;) {
    const tail = readJsonlFileSuffix<unknown>(messagesPath, maxBytes);
    let result = localTranscriptTailMessages(
      tail.items,
      messageFormat,
      activeMessageIds,
      storageDir,
      conversationDir,
    );
    const found = result.transcript.messages.length;
    if (found >= targetCount || tail.reachedStart || maxBytes >= byteBudget) {
      if (
        activeMessageIds.length === 0 &&
        result.messages.length > minMessages
      ) {
        const inferredIds = result.messages
          .slice(-minMessages)
          .map((message) => message.id);
        result = localTranscriptTailMessages(
          tail.items,
          messageFormat,
          inferredIds,
          storageDir,
          conversationDir,
        );
      }
      const returnedIds = new Set(result.messages.map((message) => message.id));
      return {
        ...result,
        reachedStart: tail.reachedStart,
        bytesRead: tail.bytesRead,
        headBytes: tail.startOffset,
        liveInContextIds:
          activeMessageIds.length > 0
            ? activeMessageIds.filter((id) => returnedIds.has(id))
            : result.messages.map((message) => message.id),
      };
    }
    maxBytes = Math.min(
      byteBudget,
      Math.max(
        maxBytes * 2,
        found > 0 ? Math.ceil((maxBytes / found) * targetCount * 1.25) : 0,
      ),
    );
  }
}

export function spliceOutOfContextMessages(
  messages: LocalMessage[],
  inContextIds: readonly string[],
  floor: number,
): LocalMessage[] {
  const inContext = new Set(inContextIds);
  const evicted: LocalMessage[] = [];
  let index = 0;
  while (index < messages.length - 1 && messages.length > floor) {
    const message = messages[index];
    if (message && !inContext.has(message.id)) {
      evicted.push(...messages.splice(index, 1));
    } else {
      index += 1;
    }
  }
  return evicted;
}

export function messagesMissingFrom(
  replaced: readonly LocalMessage[] | undefined,
  next: readonly LocalMessage[],
): LocalMessage[] {
  const nextIds = new Set(next.map((message) => message.id));
  return (replaced ?? []).filter((message) => !nextIds.has(message.id));
}

export function residentCoversIds(
  resident: readonly LocalMessage[],
  activeMessageIds: readonly string[],
): boolean {
  if (activeMessageIds.length === 0) return false;
  const residentIds = new Set(resident.map((message) => message.id));
  return activeMessageIds.every((id) => residentIds.has(id));
}

export function validateUnreadTranscriptHead(
  messagesPath: string,
  headBytes: number,
  storageDir: string,
  conversationDir: string,
  activeMessageIds: readonly string[],
): void {
  if (headBytes <= 0) return;
  let text: string;
  try {
    const fd = openSync(messagesPath, "r");
    try {
      const buffer = Buffer.alloc(headBytes);
      readSync(fd, buffer, 0, headBytes, 0);
      text = buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return;
  const rows: unknown[] = [];
  for (const line of text.slice(0, lastNewline + 1).split("\n")) {
    if (line.trim().length > 0) rows.push(JSON.parse(line));
  }
  assertNoLegacyUiMessageRows(rows, storageDir, conversationDir);
  assertNoLegacyUiMessageRows(
    localTranscriptRowsResult(
      rows,
      LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
      activeMessageIds,
    ).messages,
    storageDir,
    conversationDir,
  );
}

export function restrictLocalTranscriptToResidentMessages(
  transcript: LocalTranscriptRowsResult,
  residentMessages: readonly LocalMessage[],
): LocalTranscriptRowsResult {
  const messageById = new Map<string, LocalMessage>();
  const entryIdByMessageId = new Map<string, string>();
  const entryIds = new Set<string>();
  for (const message of residentMessages) {
    messageById.set(
      message.id,
      transcript.messageById.get(message.id) ?? message,
    );
    const entryId = transcript.entryIdByMessageId.get(message.id);
    if (entryId === undefined) continue;
    entryIdByMessageId.set(message.id, entryId);
    entryIds.add(entryId);
  }
  if (transcript.lastEntryId) entryIds.add(transcript.lastEntryId);
  return {
    messages: [...residentMessages],
    entryIds,
    entryIdByMessageId,
    messageById,
    lastEntryId: transcript.lastEntryId,
    sourceStartIndex: transcript.sourceStartIndex,
  };
}

export function overlayResidentLocalMessageTail(
  diskMessages: readonly LocalMessage[],
  residentTail: readonly LocalMessage[],
): LocalMessage[] {
  if (residentTail.length === 0) return [...diskMessages];
  const diskIds = new Set(diskMessages.map((message) => message.id));
  const merged: LocalMessage[] = [];
  let residentIndex = 0;
  for (const message of diskMessages) {
    while (residentIndex < residentTail.length) {
      const resident = residentTail[residentIndex];
      if (resident === undefined) break;
      if (resident.id === message.id || diskIds.has(resident.id)) break;
      merged.push(resident);
      residentIndex += 1;
    }
    const resident = residentTail[residentIndex];
    if (resident !== undefined && resident.id === message.id) {
      merged.push(resident);
      residentIndex += 1;
      continue;
    }
    merged.push(message);
  }
  while (residentIndex < residentTail.length) {
    const resident = residentTail[residentIndex];
    if (resident !== undefined) merged.push(resident);
    residentIndex += 1;
  }
  return merged;
}

export function overlayResidentLocalMessageSuffix(
  diskSuffix: readonly LocalMessage[],
  residentTail: readonly LocalMessage[],
  isPersisted: (messageId: string) => boolean,
): LocalMessage[] {
  if (residentTail.length === 0) return [...diskSuffix];
  const diskIds = new Set(diskSuffix.map((message) => message.id));
  const overlayTail: LocalMessage[] = [];
  let seenPersisted = false;
  for (let index = residentTail.length - 1; index >= 0; index -= 1) {
    const message = residentTail[index];
    if (!message) continue;
    if (isPersisted(message.id)) seenPersisted = true;
    if (diskIds.has(message.id) || !seenPersisted) {
      overlayTail.unshift(message);
    }
  }
  return overlayResidentLocalMessageTail(diskSuffix, overlayTail);
}
