import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MessageSearchResponse } from "@letta-ai/letta-client/resources/messages";
import { isRecord } from "@/utils/type-guards";
import type { LocalMessage } from "./local-message";
import {
  projectLocalMessageToStoredMessages,
  withProjectedMessageDates,
} from "./local-message-projection";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  type LocalTranscriptManifest,
} from "./local-store";
import type { StoredMessage } from "./local-types";

export type LocalTranscriptSearchBody = {
  query?: unknown;
  search_mode?: unknown;
  limit?: unknown;
  agent_id?: unknown;
  conversation_id?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  include_hidden?: unknown;
};

type LocalConversationSearchRecord = {
  id: string;
  agent_id: string;
  hidden?: boolean;
};

type LocalTranscriptMessageFormat =
  | typeof LOCAL_TRANSCRIPT_MESSAGE_FORMAT
  | typeof LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;

type TranscriptMessageRow = {
  timestamp?: string;
  message: LocalMessage;
  sourceIndex: number;
};

type SearchableStoredMessage = {
  message: StoredMessage;
  text: string;
  score: number;
};

function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readJsonlFile(path: string): unknown[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    return [];
  }
}

function conversationSearchRecord(
  value: unknown,
): LocalConversationSearchRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.agent_id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    agent_id: value.agent_id,
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
  };
}

function isLocalMessage(value: unknown): value is LocalMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" ||
      value.role === "assistant" ||
      value.role === "toolResult")
  );
}

function transcriptFormat(
  manifest: LocalTranscriptManifest | undefined,
  rows: readonly unknown[],
): LocalTranscriptMessageFormat | undefined {
  if (
    manifest?.message_format === LOCAL_TRANSCRIPT_MESSAGE_FORMAT ||
    manifest?.message_format === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT
  ) {
    return manifest.message_format;
  }

  // Best-effort fallback for tests or partially migrated stores. Normal local
  // backend startup enforces manifests for non-empty legacy transcripts, but
  // search should be defensive and simply skip malformed rows.
  const firstDataRow = rows.find((row) =>
    Boolean(isRecord(row) && row.type !== "session"),
  );
  if (isRecord(firstDataRow) && "message" in firstDataRow) {
    return LOCAL_TRANSCRIPT_MESSAGE_FORMAT;
  }
  if (rows.some(isLocalMessage)) {
    return LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;
  }
  return undefined;
}

function transcriptMessageRows(
  rows: readonly unknown[],
  format: LocalTranscriptMessageFormat,
): TranscriptMessageRow[] {
  if (format === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT) {
    return rows
      .map((row, sourceIndex) => ({ row, sourceIndex }))
      .filter((item): item is { row: LocalMessage; sourceIndex: number } =>
        isLocalMessage(item.row),
      )
      .map(({ row, sourceIndex }) => ({
        timestamp: row.metadata?.created_at,
        message: row,
        sourceIndex,
      }));
  }

  const messageRows: TranscriptMessageRow[] = [];
  rows.forEach((row, sourceIndex) => {
    if (!isRecord(row)) return;
    if (row.type !== "message" && row.type !== "compaction") return;
    const message = row.message;
    if (!isLocalMessage(message)) return;
    messageRows.push({
      timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
      message,
      sourceIndex,
    });
  });
  return messageRows;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function searchableText(message: StoredMessage): string {
  const localMessage = message as StoredMessage & {
    message_type?: string;
    content?: unknown;
    reasoning?: string;
    summary?: string;
    tool_call?: { name?: string; arguments?: string };
    tool_calls?: Array<{ name?: string; arguments?: string }>;
    tool_return?: unknown;
    func_response?: unknown;
  };
  const toolCalls = Array.isArray(localMessage.tool_calls)
    ? localMessage.tool_calls
    : localMessage.tool_call
      ? [localMessage.tool_call]
      : [];
  return [
    localMessage.message_type,
    textFromContent(localMessage.content),
    localMessage.reasoning,
    localMessage.summary,
    ...toolCalls.flatMap((call) => [call.name, call.arguments]),
    stringifySearchValue(localMessage.tool_return),
    stringifySearchValue(localMessage.func_response),
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n");
}

type ParsedQuery = {
  terms: string[];
  phrases: string[];
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const phrases: string[] = [];
  let buffer = "";
  let inQuote = false;
  let sawUnclosedQuote = false;

  const flush = () => {
    const value = buffer.trim();
    buffer = "";
    if (!value) return;
    if (inQuote) phrases.push(value);
    else terms.push(value);
  };

  for (const char of query.trim()) {
    if (char === '"') {
      if (inQuote) {
        flush();
        inQuote = false;
      } else {
        flush();
        inQuote = true;
      }
      continue;
    }
    if (!inQuote && /\s/.test(char)) {
      flush();
      continue;
    }
    buffer += char;
  }
  if (inQuote) sawUnclosedQuote = true;
  flush();

  if (sawUnclosedQuote) {
    return {
      terms: query
        .trim()
        .split(/\s+/)
        .map((term) => term.trim())
        .filter(Boolean),
      phrases: [],
    };
  }
  return { terms, phrases };
}

function matchScore(text: string, query: ParsedQuery): number | null {
  const haystack = normalizeText(text);
  if (!haystack) return null;

  let score = 0;
  for (const rawPhrase of query.phrases) {
    const phrase = normalizeText(rawPhrase);
    if (!phrase) continue;
    const index = haystack.indexOf(phrase);
    if (index < 0) return null;
    score += index * 0.1;
  }

  for (const rawTerm of query.terms) {
    const term = normalizeText(rawTerm);
    if (!term) continue;
    const index = haystack.indexOf(term);
    if (index < 0) return null;
    score += index + Math.max(0, 50 - term.length);
  }

  return score;
}

function dateInRange(
  createdAt: string | undefined,
  startDate: string | undefined,
  endDate: string | undefined,
): boolean {
  if (!startDate && !endDate) return true;
  if (!createdAt) return true;
  const messageTime = Date.parse(createdAt);
  if (!Number.isFinite(messageTime)) return true;

  const startTime = startDate
    ? Date.parse(startDate)
    : Number.NEGATIVE_INFINITY;
  const endTime = endDate ? Date.parse(endDate) : Number.POSITIVE_INFINITY;
  if (startDate && !Number.isFinite(startTime)) return true;
  if (endDate && !Number.isFinite(endTime)) return true;

  return messageTime >= startTime && messageTime <= endTime;
}

function toSearchResult(message: StoredMessage): MessageSearchResponse[number] {
  const localMessage = message as StoredMessage & {
    id?: string;
    date?: string;
    agent_id?: string;
    conversation_id?: string;
  };
  const createdAt = localMessage.date ?? new Date(0).toISOString();
  return {
    ...localMessage,
    message_id:
      localMessage.id ?? `${localMessage.agent_id ?? "local"}:${createdAt}`,
    created_at: createdAt,
    agent_id: localMessage.agent_id ?? null,
    conversation_id: localMessage.conversation_id ?? null,
  } as MessageSearchResponse[number];
}

function projectedTranscriptMessages(input: {
  row: TranscriptMessageRow;
  agentId: string;
  conversationId: string;
}): StoredMessage[] {
  const fallbackDate =
    input.row.timestamp ??
    input.row.message.metadata?.created_at ??
    new Date(0).toISOString();
  const projected = projectLocalMessageToStoredMessages(
    input.row.message,
    input.agentId,
    input.conversationId,
    fallbackDate,
  );
  return withProjectedMessageDates(projected, input.row.sourceIndex);
}

function collectConversationMessages(input: {
  conversationDir: string;
  conversation: LocalConversationSearchRecord;
  query: ParsedQuery;
  agentId?: string;
  conversationId?: string;
  startDate?: string;
  endDate?: string;
}): SearchableStoredMessage[] {
  const { conversation, conversationDir } = input;
  if (input.agentId && conversation.agent_id !== input.agentId) return [];
  if (input.conversationId && conversation.id !== input.conversationId)
    return [];

  const messagesPath = join(conversationDir, "messages.jsonl");
  const rows = readJsonlFile(messagesPath);
  if (rows.length === 0) return [];
  const manifest = readJsonFile<LocalTranscriptManifest>(
    join(conversationDir, "manifest.json"),
  );
  const format = transcriptFormat(manifest, rows);
  if (!format) return [];

  return transcriptMessageRows(rows, format)
    .flatMap((row) =>
      projectedTranscriptMessages({
        row,
        agentId: conversation.agent_id,
        conversationId: conversation.id,
      }),
    )
    .map((message) => ({
      message,
      text: searchableText(message),
      score: Number.POSITIVE_INFINITY,
    }))
    .map((record) => {
      const score = matchScore(record.text, input.query);
      return score === null ? null : { ...record, score };
    })
    .filter((record): record is SearchableStoredMessage => record !== null)
    .filter((record) => {
      const message = record.message as StoredMessage & { date?: string };
      return dateInRange(message.date, input.startDate, input.endDate);
    });
}

function conversationDirectories(storageDir: string): string[] {
  const conversationsDir = join(storageDir, "conversations");
  if (!existsSync(conversationsDir)) return [];
  try {
    return readdirSync(conversationsDir)
      .map((entry) => join(conversationsDir, entry))
      .filter((entryPath) => statSync(entryPath).isDirectory());
  } catch {
    return [];
  }
}

export function searchLocalTranscriptMessages(
  storageDir: string,
  body: LocalTranscriptSearchBody,
): MessageSearchResponse {
  const queryText = typeof body.query === "string" ? body.query.trim() : "";
  if (!queryText) return [];
  // Local mode intentionally treats vector/hybrid as FTS-lite until a local
  // vector index exists, so `search_mode` does not branch here.

  const parsedQuery = parseQuery(queryText);
  if (parsedQuery.terms.length === 0 && parsedQuery.phrases.length === 0) {
    return [];
  }

  const limit = typeof body.limit === "number" ? Math.max(0, body.limit) : 100;
  if (limit === 0) return [];
  const agentId = typeof body.agent_id === "string" ? body.agent_id : undefined;
  const conversationId =
    typeof body.conversation_id === "string" ? body.conversation_id : undefined;
  const startDate =
    typeof body.start_date === "string" ? body.start_date : undefined;
  const endDate = typeof body.end_date === "string" ? body.end_date : undefined;
  const includeHidden = body.include_hidden === true;

  const records = conversationDirectories(storageDir).flatMap(
    (conversationDir) => {
      const conversation = conversationSearchRecord(
        readJsonFile(join(conversationDir, "conversation.json")),
      );
      if (!conversation) return [];
      if (conversation.hidden && !includeHidden) return [];
      return collectConversationMessages({
        conversationDir,
        conversation,
        query: parsedQuery,
        agentId,
        conversationId,
        startDate,
        endDate,
      });
    },
  );

  return records
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      const aDate = (a.message as StoredMessage & { date?: string }).date ?? "";
      const bDate = (b.message as StoredMessage & { date?: string }).date ?? "";
      return bDate.localeCompare(aDate);
    })
    .slice(0, limit)
    .map((record) => toSearchResult(record.message));
}
