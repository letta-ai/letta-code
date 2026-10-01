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
} from "./local-transcript";
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
  normalizedText: string;
  tokens: string[];
  score: number;
  isSearchEcho: boolean;
};

type LocalTranscriptSearchOptions = {
  currentConversationId?: string;
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

const CJK_RUN =
  /^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]+$/u;
const CJK_CHARACTER =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;

function tokenize(value: string): string[] {
  const words =
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.flatMap((word) => {
    if (CJK_RUN.test(word) || !CJK_CHARACTER.test(word)) return [word];
    const runs: string[] = [];
    let run = "";
    let previousCjk = false;
    for (const character of word) {
      const cjk = CJK_RUN.test(character);
      if (run && cjk !== previousCjk) {
        runs.push(run);
        run = "";
      }
      run += character;
      previousCjk = cjk;
    }
    if (run) runs.push(run);
    return runs;
  });
}

function normalizeText(value: string): string {
  return tokenize(value).join(" ");
}

function termFrequency(tokens: readonly string[], term: string): number {
  if (CJK_RUN.test(term)) {
    // These scripts commonly omit word separators. Preserve substring recall
    // within a run without restoring Latin token-suffix matches.
    return tokens.reduce(
      (count, token) => count + token.split(term).length - 1,
      0,
    );
  }
  return tokens.reduce((count, token) => count + Number(token === term), 0);
}

function matchesPhrase(text: string, phrase: string): boolean {
  const characters = Array.from(phrase);
  const left = CJK_RUN.test(characters[0] ?? "") ? "" : " ";
  const right = CJK_RUN.test(characters.at(-1) ?? "") ? "" : " ";
  return ` ${text} `.includes(`${left}${phrase}${right}`);
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
    if (inQuote) phrases.push(normalizeText(value));
    else terms.push(...tokenize(value));
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
    buffer += char;
  }
  if (inQuote) sawUnclosedQuote = true;
  flush();

  if (sawUnclosedQuote) {
    return { terms: [...new Set(tokenize(query))], phrases: [] };
  }
  return {
    terms: [...new Set(terms)],
    phrases: [...new Set(phrases.filter(Boolean))],
  };
}

function rankMatches(
  records: SearchableStoredMessage[],
  query: ParsedQuery,
): SearchableStoredMessage[] {
  const phraseMatches = records.filter((record) =>
    query.phrases.every((phrase) =>
      matchesPhrase(record.normalizedText, phrase),
    ),
  );
  const candidates = phraseMatches.filter(
    (record) =>
      query.phrases.length > 0 ||
      query.terms.some((term) => termFrequency(record.tokens, term) > 0),
  );
  if (candidates.length === 0) return [];

  const historicalRecords = records.filter((record) => !record.isSearchEcho);
  const corpus = historicalRecords.length > 0 ? historicalRecords : records;
  const documentFrequency = new Map<string, number>();
  for (const term of query.terms) {
    documentFrequency.set(
      term,
      corpus.filter((record) => termFrequency(record.tokens, term) > 0).length,
    );
  }
  const averageLength =
    corpus.reduce((sum, record) => sum + record.tokens.length, 0) /
    corpus.length;
  const k1 = 1.2;
  const b = 0.75;

  return candidates.map((record) => {
    let score = 0;
    for (const term of query.terms) {
      const frequency = termFrequency(record.tokens, term);
      if (frequency === 0) continue;
      const frequencyInDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 +
          (corpus.length - frequencyInDocuments + 0.5) /
            (frequencyInDocuments + 0.5),
      );
      const lengthNormalization =
        1 - b + b * (record.tokens.length / Math.max(averageLength, 1));
      score +=
        inverseDocumentFrequency *
        ((frequency * (k1 + 1)) / (frequency + k1 * lengthNormalization));
    }
    // Quotes remain strict filters and receive a boost so exact phrasing wins
    // when mixed with optional unquoted terms.
    score += query.phrases.length * 2;
    return { ...record, score: score * (record.isSearchEcho ? 0.1 : 1) };
  });
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

  const messages = transcriptMessageRows(rows, format).flatMap((row) =>
    projectedTranscriptMessages({
      row,
      agentId: conversation.agent_id,
      conversationId: conversation.id,
    }),
  );
  const searchToolCallIds = new Set(
    messages
      .filter((message) => {
        const candidate = message as StoredMessage & {
          message_type?: string;
          tool_call?: {
            tool_call_id?: string;
            name?: string;
            arguments?: string;
          };
        };
        return (
          candidate.message_type === "approval_request_message" &&
          (candidate.tool_call?.name === "Bash" ||
            candidate.tool_call?.name === "exec_command") &&
          typeof candidate.tool_call.arguments === "string" &&
          /\bmessages\s+search\b/i.test(candidate.tool_call.arguments)
        );
      })
      .map((message) => {
        const candidate = message as StoredMessage & {
          tool_call?: { tool_call_id?: string };
        };
        return candidate.tool_call?.tool_call_id;
      })
      .filter((id): id is string => typeof id === "string"),
  );

  return messages
    .filter((message) =>
      dateInRange(message.date, input.startDate, input.endDate),
    )
    .map((message) => {
      const candidate = message as StoredMessage & {
        message_type?: string;
        tool_call?: { tool_call_id?: string };
        tool_call_id?: string;
      };
      const text = searchableText(message);
      return {
        message,
        normalizedText: normalizeText(text),
        tokens: tokenize(text),
        score: 0,
        isSearchEcho:
          (candidate.message_type === "approval_request_message" &&
            searchToolCallIds.has(candidate.tool_call?.tool_call_id ?? "")) ||
          (candidate.message_type === "tool_return_message" &&
            searchToolCallIds.has(candidate.tool_call_id ?? "")),
      };
    })
    .filter((record) => record.tokens.length > 0);
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
  options: LocalTranscriptSearchOptions = {},
): MessageSearchResponse {
  if (body.search_mode === "vector" || body.search_mode === "hybrid") {
    throw new Error(
      `Local backend does not support "${body.search_mode}" message search. Use "fts".`,
    );
  }
  const queryText = typeof body.query === "string" ? body.query.trim() : "";
  if (!queryText) return [];

  const parsedQuery = parseQuery(queryText);
  if (parsedQuery.terms.length === 0 && parsedQuery.phrases.length === 0) {
    return [];
  }

  const limit = typeof body.limit === "number" ? Math.max(0, body.limit) : 100;
  if (limit === 0) return [];
  const agentId = typeof body.agent_id === "string" ? body.agent_id : undefined;
  const conversationId =
    typeof body.conversation_id === "string" ? body.conversation_id : undefined;
  if (conversationId === "default" && !agentId) return [];
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
        agentId,
        conversationId,
        startDate,
        endDate,
      });
    },
  );

  // Unscoped recall runs from inside the active conversation, whose newest user
  // message is commonly the question being recalled. Demote that one message,
  // plus messages-search command/result pairs, instead of deleting tool results
  // globally. Explicit conversation searches remain literal and unmodified.
  if (!conversationId && options.currentConversationId) {
    const latestCurrentUser = records
      .filter(
        (record) =>
          record.message.conversation_id === options.currentConversationId &&
          record.message.message_type === "user_message",
      )
      .sort((a, b) => b.message.date.localeCompare(a.message.date))[0];
    if (latestCurrentUser) latestCurrentUser.isSearchEcho = true;
  }

  return rankMatches(records, parsedQuery)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.message.date.localeCompare(a.message.date);
    })
    .slice(0, limit)
    .map((record) => toSearchResult(record.message));
}
