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
  forEachJsonlRow,
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

type SearchRecord = {
  /** Kept only for query matches; other rows keep just ranking statistics. */
  message?: StoredMessage;
  date: string;
  conversationId?: string;
  messageType?: string;
  tokenCount: number;
  /** Frequency of each parsed query term, in query order. */
  termFrequencies: number[];
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

function transcriptFormatFromManifest(
  manifest: LocalTranscriptManifest | undefined,
): LocalTranscriptMessageFormat | undefined {
  if (
    manifest?.message_format === LOCAL_TRANSCRIPT_MESSAGE_FORMAT ||
    manifest?.message_format === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT
  ) {
    return manifest.message_format;
  }
  return undefined;
}

function transcriptMessageRow(
  row: unknown,
  sourceIndex: number,
  format: LocalTranscriptMessageFormat,
): TranscriptMessageRow | undefined {
  if (format === LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT) {
    if (!isLocalMessage(row)) return undefined;
    return { timestamp: row.metadata?.created_at, message: row, sourceIndex };
  }
  if (!isRecord(row)) return undefined;
  if (row.type !== "message" && row.type !== "compaction") return undefined;
  const message = row.message;
  if (!isLocalMessage(message)) return undefined;
  return {
    timestamp: typeof row.timestamp === "string" ? row.timestamp : undefined,
    message,
    sourceIndex,
  };
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
  records: SearchRecord[],
  query: ParsedQuery,
): SearchRecord[] {
  const candidates = records.filter((record) => record.message !== undefined);
  if (candidates.length === 0) return [];

  const historicalRecords = records.filter((record) => !record.isSearchEcho);
  const corpus = historicalRecords.length > 0 ? historicalRecords : records;
  const documentFrequency = query.terms.map(
    (_term, termIndex) =>
      corpus.filter((record) => (record.termFrequencies[termIndex] ?? 0) > 0)
        .length,
  );
  const averageLength =
    corpus.reduce((sum, record) => sum + record.tokenCount, 0) / corpus.length;
  const k1 = 1.2;
  const b = 0.75;

  return candidates.map((record) => {
    let score = 0;
    query.terms.forEach((_term, termIndex) => {
      const frequency = record.termFrequencies[termIndex] ?? 0;
      if (frequency === 0) return;
      const frequencyInDocuments = documentFrequency[termIndex] ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 +
          (corpus.length - frequencyInDocuments + 0.5) /
            (frequencyInDocuments + 0.5),
      );
      const lengthNormalization =
        1 - b + b * (record.tokenCount / Math.max(averageLength, 1));
      score +=
        inverseDocumentFrequency *
        ((frequency * (k1 + 1)) / (frequency + k1 * lengthNormalization));
    });
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

function searchToolCallId(message: StoredMessage): string | undefined {
  const candidate = message as StoredMessage & {
    message_type?: string;
    tool_call?: { tool_call_id?: string; name?: string; arguments?: string };
  };
  if (
    candidate.message_type === "approval_request_message" &&
    (candidate.tool_call?.name === "Bash" ||
      candidate.tool_call?.name === "exec_command") &&
    typeof candidate.tool_call.arguments === "string" &&
    /\bmessages\s+search\b/i.test(candidate.tool_call.arguments) &&
    typeof candidate.tool_call.tool_call_id === "string"
  ) {
    return candidate.tool_call.tool_call_id;
  }
  return undefined;
}

function echoToolCallId(message: StoredMessage): string | undefined {
  const candidate = message as StoredMessage & {
    message_type?: string;
    tool_call?: { tool_call_id?: string };
    tool_call_id?: string;
  };
  if (candidate.message_type === "approval_request_message") {
    return candidate.tool_call?.tool_call_id ?? "";
  }
  if (candidate.message_type === "tool_return_message") {
    return candidate.tool_call_id ?? "";
  }
  return undefined;
}

/**
 * Streams one conversation's messages.jsonl row by row. Each projected
 * message is matched against the query as it is read; only matches keep
 * their message, everything else keeps the few numbers BM25 needs. The
 * transcript is never held in memory as a whole.
 */
function collectConversationMessages(input: {
  conversationDir: string;
  conversation: LocalConversationSearchRecord;
  query: ParsedQuery;
  agentId?: string;
  conversationId?: string;
  startDate?: string;
  endDate?: string;
}): SearchRecord[] {
  const { conversation, conversationDir, query } = input;
  if (input.agentId && conversation.agent_id !== input.agentId) return [];
  if (input.conversationId && conversation.id !== input.conversationId)
    return [];

  const manifest = readJsonFile<LocalTranscriptManifest>(
    join(conversationDir, "manifest.json"),
  );
  let format = transcriptFormatFromManifest(manifest);
  const records: SearchRecord[] = [];
  const echoToolCallIds: (string | undefined)[] = [];
  const searchToolCallIds = new Set<string>();
  // Rows seen before an unversioned transcript's format is known (headers).
  const undecidedRows: { row: unknown; rowIndex: number }[] = [];
  let sourceIndex = 0;

  const addRow = (row: unknown, rowIndex: number) => {
    if (!format) return;
    const messageRow = transcriptMessageRow(row, rowIndex, format);
    if (!messageRow) return;
    const projected = projectedTranscriptMessages({
      row: messageRow,
      agentId: conversation.agent_id,
      conversationId: conversation.id,
    });
    for (const message of projected) {
      const searchId = searchToolCallId(message);
      if (searchId !== undefined) searchToolCallIds.add(searchId);
      if (!dateInRange(message.date, input.startDate, input.endDate)) continue;
      const tokens = tokenize(searchableText(message));
      if (tokens.length === 0) continue;
      const termFrequencies = query.terms.map((term) =>
        termFrequency(tokens, term),
      );
      const normalizedText = tokens.join(" ");
      const matches =
        query.phrases.every((phrase) =>
          matchesPhrase(normalizedText, phrase),
        ) &&
        (query.phrases.length > 0 ||
          termFrequencies.some((frequency) => frequency > 0));
      const localMessage = message as StoredMessage & {
        conversation_id?: string;
        message_type?: string;
      };
      records.push({
        ...(matches ? { message } : {}),
        date: message.date,
        conversationId: localMessage.conversation_id,
        messageType: localMessage.message_type,
        tokenCount: tokens.length,
        termFrequencies,
        score: 0,
        isSearchEcho: false,
      });
      echoToolCallIds.push(echoToolCallId(message));
    }
  };

  // Unversioned transcripts: infer the format from the first data row, as
  // the full-file reader did (session rows wrap a message; legacy rows are
  // bare messages).
  const handleRow = (row: unknown) => {
    const rowIndex = sourceIndex;
    sourceIndex += 1;
    if (!format) {
      if (!isRecord(row) || row.type === "session") {
        undecidedRows.push({ row, rowIndex });
        return;
      }
      format =
        "message" in row
          ? LOCAL_TRANSCRIPT_MESSAGE_FORMAT
          : LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;
      for (const undecided of undecidedRows) {
        addRow(undecided.row, undecided.rowIndex);
      }
      undecidedRows.length = 0;
    }
    addRow(row, rowIndex);
  };

  const messagesPath = join(conversationDir, "messages.jsonl");
  let rowError: unknown;
  try {
    forEachJsonlRow<unknown>(messagesPath, (row) => {
      try {
        handleRow(row);
      } catch (error) {
        rowError = error;
        throw error;
      }
    });
  } catch (error) {
    // Unreadable or malformed transcripts are skipped; projection errors
    // still propagate.
    if (rowError !== undefined && error === rowError) throw error;
    return [];
  }
  if (!format && undecidedRows.some(({ row }) => isLocalMessage(row))) {
    format = LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;
    for (const undecided of undecidedRows) {
      addRow(undecided.row, undecided.rowIndex);
    }
  }

  records.forEach((record, index) => {
    const toolCallId = echoToolCallIds[index];
    record.isSearchEcho =
      toolCallId !== undefined && searchToolCallIds.has(toolCallId);
  });
  return records;
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
        query: parsedQuery,
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
  // globally. Explicit conversation targets do not demote their newest user message.
  if (!conversationId && options.currentConversationId) {
    const latestCurrentUser = records
      .filter(
        (record) =>
          record.conversationId === options.currentConversationId &&
          record.messageType === "user_message",
      )
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    if (latestCurrentUser) latestCurrentUser.isSearchEcho = true;
  }

  return rankMatches(records, parsedQuery)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.date.localeCompare(a.date);
    })
    .slice(0, limit)
    .flatMap((record) =>
      record.message ? [toSearchResult(record.message)] : [],
    );
}
