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
import type { LocalCompactionStats } from "./compaction";
import type { LocalMessage } from "./local-message";

export function currentIsoTimestamp(): string {
  return new Date().toISOString();
}

export function isoFromTimestamp(
  value: number | undefined,
): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

export function jsonl<T>(items: readonly T[]): string {
  return `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export const LOCAL_TRANSCRIPT_LEGACY_SCHEMA_VERSION = 1;
export const LOCAL_TRANSCRIPT_SCHEMA_VERSION = 2;
export const LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT = "pi-ai-message-jsonl";
export const LOCAL_TRANSCRIPT_MESSAGE_FORMAT = "pi-session-entry-jsonl";
export const LOCAL_TRANSCRIPT_PROVIDER_STACK = "pi-ai";

export type LocalTranscriptSchemaVersion =
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
  // Map#set does not move an existing key to the insertion tail. Delete first so
  // append-only replacement snapshots preserve latest-message order when a
  // conversation has no explicit in-context id list.
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

function isLocalTranscriptAppendEntry(
  value: unknown,
): value is LocalTranscriptAppendEntry {
  return (
    isLocalTranscriptSessionMessageEntry(value) ||
    isLocalTranscriptCompactionEntry(value)
  );
}

export function createLocalTranscriptSessionHeader(conversation: {
  id: string;
  created_at?: string | null;
}): LocalTranscriptSessionHeader {
  return {
    type: "session",
    version: 3,
    id: conversation.id,
    timestamp: conversation.created_at ?? currentIsoTimestamp(),
    cwd: process.cwd(),
  };
}

export function localTranscriptSessionEntries(
  conversation: { id: string; created_at?: string | null },
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

export function numericSuffix(value: string, prefix: string): number {
  return value.startsWith(prefix)
    ? Number.parseInt(value.slice(prefix.length), 10) || 0
    : 0;
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

/**
 * Maximum number of messages the local store keeps resident per conversation.
 * Everything older is paged back from the transcript on disk on demand, so
 * resident memory stays bounded instead of scaling with transcript size.
 * Mirrors the cloud path's tail policy (BACKFILL_PAGE_LIMIT = 50) with
 * headroom for tool call/result pairs spanning a window edge.
 */
export const LOCAL_STORE_RESIDENT_MESSAGE_LIMIT = 100;

const TRANSCRIPT_WINDOW_INITIAL_BYTES = 64 * 1024;

export function readJsonlFile<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function readJsonlFileSuffix<T>(
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

function transcriptRowMessageId(row: unknown): string | undefined {
  // Session-entry rows wrap the message; legacy rows are bare messages.
  if (!isRecord(row)) return undefined;
  if (
    (row.type === "message" || row.type === "compaction") &&
    isRecord(row.message) &&
    typeof row.message.id === "string"
  ) {
    return row.message.id;
  }
  return typeof row.id === "string" ? row.id : undefined;
}

export interface LocalTranscriptWindowRead {
  rows: unknown[];
  reachedStart: boolean;
}

/**
 * Reads a suffix of a transcript JSONL, doubling the byte window until it
 * covers the requested messages or the start of the file is reached.
 *
 * - `minActiveMessages`: stop once the suffix holds at least this many rows
 *   whose message id is in `activeMessageIds`.
 * - `coverAllActiveMessages`: stop once every id in `activeMessageIds` has
 *   been seen (a full in-context window read).
 *
 * With an empty `activeMessageIds` set every append row counts as active.
 */
export function readJsonlFileTailWindow(
  path: string,
  options: {
    activeMessageIds: readonly string[];
    minActiveMessages?: number;
    coverAllActiveMessages?: boolean;
  },
): LocalTranscriptWindowRead {
  const activeIds = new Set(options.activeMessageIds);
  const minActiveMessages = Math.max(1, options.minActiveMessages ?? 1);
  let maxBytes = TRANSCRIPT_WINDOW_INITIAL_BYTES;
  for (;;) {
    const suffix = readJsonlFileSuffix<unknown>(path, maxBytes);
    if (suffix.reachedStart) {
      return { rows: suffix.items, reachedStart: true };
    }
    let activeFound = 0;
    let allCovered = activeIds.size === 0;
    const seen = new Set<string>();
    for (const row of suffix.items) {
      const messageId = transcriptRowMessageId(row);
      if (messageId === undefined) continue;
      if (activeIds.size === 0 || activeIds.has(messageId)) {
        activeFound += 1;
        seen.add(messageId);
      }
    }
    if (options.coverAllActiveMessages) {
      allCovered = activeIds.size > 0 && seen.size >= activeIds.size;
      if (allCovered) return { rows: suffix.items, reachedStart: false };
    } else if (activeFound >= minActiveMessages) {
      return { rows: suffix.items, reachedStart: false };
    }
    maxBytes *= 2;
  }
}
