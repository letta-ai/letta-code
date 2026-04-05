import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getClient } from "../../agent/client";
import { debugLog, debugWarn } from "../../utils/debug";

const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";
const DEFAULT_TRANSCRIPT_DIR = "transcripts";

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_IDLE_MINUTES = 60;
const DEFAULT_MAX_CONVERSATIONS = 25;
const CONVERSATION_LIST_PAGE_LIMIT = 50;
const MESSAGE_LIST_PAGE_LIMIT = 100;
const MAX_PAGES_PER_QUERY = 25;

interface ConversationSummary {
  id: string;
  created_at?: string | null;
  updated_at?: string | null;
  last_message_at?: string | null;
}

interface TranscriptMessage {
  id?: string;
  date?: string;
  message_type?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_returns?: unknown;
  tool_call_id?: string;
  status?: string;
  tool_return?: unknown;
  [key: string]: unknown;
}

interface PaginatedList<T> {
  getPaginatedItems(): T[];
}

interface ReflectionReviewClient {
  conversations: {
    list(query: {
      agent_id: string;
      limit: number;
      order: "asc" | "desc";
      order_by: "created_at" | "last_run_completion" | "last_message_at";
      after?: string;
    }): Promise<PaginatedList<ConversationSummary>>;
    messages: {
      list(
        conversationId: string,
        query: {
          limit: number;
          order: "asc" | "desc";
          agent_id?: string;
          before?: string;
          after?: string;
        },
      ): Promise<PaginatedList<TranscriptMessage>>;
    };
  };
  agents: {
    messages: {
      list(
        agentId: string,
        query: {
          conversation_id: string;
          limit: number;
          order: "asc" | "desc";
        },
      ): Promise<PaginatedList<TranscriptMessage>>;
    };
  };
}

export interface ReflectionReviewCheckpoint {
  agent_id: string;
  conversation_id: string;
  last_reviewed_message_id: string | null;
  last_reviewed_timestamp: string | null;
  last_messaged_at: string | null;
  reflection_agent_id: string | null;
}

interface ReflectionReviewState {
  version: 1;
  agent_id: string;
  conversations: ReflectionReviewCheckpoint[];
}

interface ReflectionStatePaths {
  rootDir: string;
  statePath: string;
  triggerLogPath: string;
}

interface ConversationCandidate {
  conversationId: string;
  lastMessagedAt: string;
}

export interface ReflectionReviewSegment {
  agentId: string;
  primaryConversationId: string;
  conversationId: string;
  transcriptPath: string;
  startMessageId: string;
  endMessageId: string;
  startTimestamp: string;
  endTimestamp: string;
  lastMessagedAt: string;
  checkpointBefore: ReflectionReviewCheckpoint;
}

export interface CollectReflectionSweepParams {
  agentId: string;
  primaryConversationId: string;
  lookbackHours?: number;
  idleMinutes?: number;
  maxConversations?: number;
  now?: Date;
  client?: ReflectionReviewClient;
}

export interface ReflectionTriggerLogEntry {
  primary_agent_id: string;
  primary_conversation_id: string;
  reviewed_conversation_id: string | null;
  starting_message_id: string | null;
  ending_message_id: string | null;
  reflection_agent_id: string | null;
  starting_timestamp: string | null;
  ending_timestamp: string | null;
  trigger_source: "step-count" | "compaction-event";
  status: "launched" | "completed" | "failed" | "skipped";
  error?: string;
}

export interface ReflectionReviewDebugInfo {
  statePath: string;
  triggerLogPath: string;
  checkpoint: ReflectionReviewCheckpoint;
}

const stateUpdateQueues = new Map<string, Promise<void>>();

function queueStateUpdate<T>(
  agentId: string,
  op: () => Promise<T>,
): Promise<T> {
  const previous = stateUpdateQueues.get(agentId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(op);
  stateUpdateQueues.set(
    agentId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "unknown";
}

function getTranscriptRoot(): string {
  const envRoot = process.env[TRANSCRIPT_ROOT_ENV]?.trim();
  if (envRoot) {
    return envRoot;
  }
  return join(homedir(), ".letta", DEFAULT_TRANSCRIPT_DIR);
}

function getStatePaths(agentId: string): ReflectionStatePaths {
  const agentDir = sanitizePathSegment(agentId);
  const rootDir = join(getTranscriptRoot(), agentDir, "reflection-review");
  return {
    rootDir,
    statePath: join(rootDir, "state.json"),
    triggerLogPath: join(rootDir, "trigger-log.jsonl"),
  };
}

function defaultCheckpoint(
  agentId: string,
  conversationId: string,
): ReflectionReviewCheckpoint {
  return {
    agent_id: agentId,
    conversation_id: conversationId,
    last_reviewed_message_id: null,
    last_reviewed_timestamp: null,
    last_messaged_at: null,
    reflection_agent_id: null,
  };
}

function defaultState(agentId: string): ReflectionReviewState {
  return {
    version: 1,
    agent_id: agentId,
    conversations: [],
  };
}

async function ensureStateDir(paths: ReflectionStatePaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
}

function normalizeCheckpoint(
  agentId: string,
  raw: Partial<ReflectionReviewCheckpoint>,
): ReflectionReviewCheckpoint {
  return {
    agent_id: agentId,
    conversation_id:
      typeof raw.conversation_id === "string" ? raw.conversation_id : "default",
    last_reviewed_message_id:
      typeof raw.last_reviewed_message_id === "string"
        ? raw.last_reviewed_message_id
        : null,
    last_reviewed_timestamp:
      typeof raw.last_reviewed_timestamp === "string"
        ? raw.last_reviewed_timestamp
        : null,
    last_messaged_at:
      typeof raw.last_messaged_at === "string" ? raw.last_messaged_at : null,
    reflection_agent_id:
      typeof raw.reflection_agent_id === "string"
        ? raw.reflection_agent_id
        : null,
  };
}

async function readState(agentId: string): Promise<ReflectionReviewState> {
  const paths = getStatePaths(agentId);
  await ensureStateDir(paths);
  try {
    const raw = await readFile(paths.statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReflectionReviewState>;
    const checkpoints = Array.isArray(parsed.conversations)
      ? parsed.conversations.map((entry) => normalizeCheckpoint(agentId, entry))
      : [];
    return {
      version: 1,
      agent_id: agentId,
      conversations: checkpoints,
    };
  } catch {
    return defaultState(agentId);
  }
}

async function writeState(
  agentId: string,
  state: ReflectionReviewState,
): Promise<void> {
  const paths = getStatePaths(agentId);
  await ensureStateDir(paths);
  await writeFile(
    paths.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function getCheckpoint(
  state: ReflectionReviewState,
  conversationId: string,
): ReflectionReviewCheckpoint {
  const existing = state.conversations.find(
    (entry) => entry.conversation_id === conversationId,
  );
  if (existing) {
    return existing;
  }
  const created = defaultCheckpoint(state.agent_id, conversationId);
  state.conversations.push(created);
  return created;
}

async function appendTriggerLog(
  agentId: string,
  entry: ReflectionTriggerLogEntry,
): Promise<void> {
  const paths = getStatePaths(agentId);
  await ensureStateDir(paths);
  const payload = {
    ...entry,
    logged_at: new Date().toISOString(),
  };
  await appendFile(
    paths.triggerLogPath,
    `${JSON.stringify(payload)}\n`,
    "utf-8",
  );
}

function buildTranscriptPath(conversationId: string): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(
    tmpdir(),
    `letta-reflection-${sanitizePathSegment(conversationId)}-${nonce}.txt`,
  );
}

function renderUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const partRecord = part as Record<string, unknown>;
      if (typeof partRecord.text === "string") {
        return partRecord.text;
      }
      if (Array.isArray(partRecord.summary)) {
        return (partRecord.summary as Array<Record<string, unknown>>)
          .map((item) =>
            typeof item?.text === "string" ? item.text : renderUnknown(item),
          )
          .join("\n");
      }
      return renderUnknown(part);
    })
    .filter((part) => part.trim().length > 0);
  return parts.join("\n");
}

function renderMessageBody(message: TranscriptMessage): string {
  const parts: string[] = [];
  const contentText = contentToText(message.content);
  if (contentText) {
    parts.push(contentText);
  }

  if (message.tool_calls) {
    parts.push(`<tool_calls>${renderUnknown(message.tool_calls)}</tool_calls>`);
  }

  if (message.tool_returns) {
    parts.push(
      `<tool_returns>${renderUnknown(message.tool_returns)}</tool_returns>`,
    );
  }

  if (message.tool_return !== undefined) {
    parts.push(
      `<tool_return>${renderUnknown(message.tool_return)}</tool_return>`,
    );
  }

  if (parts.length === 0) {
    return "(no content)";
  }
  return parts.join("\n");
}

function serializeMessages(
  messages: TranscriptMessage[],
  params: {
    primaryConversationId: string;
    conversationId: string;
    startMessageId: string;
    endMessageId: string;
    startTimestamp: string;
    endTimestamp: string;
  },
): string {
  const lines: string[] = [
    `<reflection_segment primary_conversation_id="${params.primaryConversationId}" conversation_id="${params.conversationId}">`,
    `<segment_range start_message_id="${params.startMessageId}" end_message_id="${params.endMessageId}" start_timestamp="${params.startTimestamp}" end_timestamp="${params.endTimestamp}" />`,
    "",
  ];

  for (const message of messages) {
    const id = message.id ?? "unknown";
    const type = message.message_type ?? "unknown";
    const timestamp = message.date ?? "unknown";
    const body = renderMessageBody(message);
    lines.push(`<message id="${id}" type="${type}" timestamp="${timestamp}">`);
    lines.push(body);
    lines.push("</message>");
    lines.push("");
  }

  lines.push("</reflection_segment>");
  return lines.join("\n");
}

async function fetchConversationMessagesSince(
  client: ReflectionReviewClient,
  agentId: string,
  conversationId: string,
  sinceMs: number,
): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  const seenIds = new Set<string>();
  let before: string | undefined;

  for (let pageIdx = 0; pageIdx < MAX_PAGES_PER_QUERY; pageIdx += 1) {
    const page = await client.conversations.messages.list(conversationId, {
      limit: MESSAGE_LIST_PAGE_LIMIT,
      order: "desc",
      ...(conversationId === "default" ? { agent_id: agentId } : {}),
      ...(before ? { before } : {}),
    });
    const items = page.getPaginatedItems();
    if (items.length === 0) {
      break;
    }

    let sawOlder = false;
    for (const message of items) {
      const ts = parseTimestamp(message.date);
      if (ts !== null && ts < sinceMs) {
        sawOlder = true;
        continue;
      }
      if (!message.id || seenIds.has(message.id)) {
        continue;
      }
      seenIds.add(message.id);
      out.push(message);
    }

    before = items[items.length - 1]?.id;
    if (sawOlder || items.length < MESSAGE_LIST_PAGE_LIMIT || !before) {
      break;
    }
  }

  return out.sort((a, b) => {
    const ta = parseTimestamp(a.date) ?? 0;
    const tb = parseTimestamp(b.date) ?? 0;
    return ta - tb;
  });
}

async function fetchConversationMessagesAfter(
  client: ReflectionReviewClient,
  agentId: string,
  conversationId: string,
  afterMessageId: string,
): Promise<TranscriptMessage[]> {
  const out: TranscriptMessage[] = [];
  const seenIds = new Set<string>();
  let after = afterMessageId;

  for (let pageIdx = 0; pageIdx < MAX_PAGES_PER_QUERY; pageIdx += 1) {
    const page = await client.conversations.messages.list(conversationId, {
      limit: MESSAGE_LIST_PAGE_LIMIT,
      order: "asc",
      ...(conversationId === "default" ? { agent_id: agentId } : {}),
      ...(after ? { after } : {}),
    });
    const items = page.getPaginatedItems();
    if (items.length === 0) {
      break;
    }

    for (const item of items) {
      if (!item.id || seenIds.has(item.id)) {
        continue;
      }
      seenIds.add(item.id);
      out.push(item);
    }

    after = items[items.length - 1]?.id ?? "";
    if (items.length < MESSAGE_LIST_PAGE_LIMIT || !after) {
      break;
    }
  }

  return out;
}

async function listRecentConversations(
  client: ReflectionReviewClient,
  agentId: string,
  lookbackStartMs: number,
  maxConversations: number,
): Promise<ConversationCandidate[]> {
  const candidates: ConversationCandidate[] = [];
  const seen = new Set<string>();

  let after: string | undefined;
  for (let pageIdx = 0; pageIdx < MAX_PAGES_PER_QUERY; pageIdx += 1) {
    const page = await client.conversations.list({
      agent_id: agentId,
      limit: CONVERSATION_LIST_PAGE_LIMIT,
      order: "desc",
      order_by: "last_message_at",
      ...(after ? { after } : {}),
    });
    const items = page.getPaginatedItems();
    if (items.length === 0) {
      break;
    }

    let reachedLookbackEnd = false;
    for (const item of items) {
      const candidateTime =
        parseTimestamp(item.last_message_at) ??
        parseTimestamp(item.updated_at) ??
        parseTimestamp(item.created_at);
      if (candidateTime === null) {
        continue;
      }
      if (candidateTime < lookbackStartMs) {
        reachedLookbackEnd = true;
        continue;
      }
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      candidates.push({
        conversationId: item.id,
        lastMessagedAt: toIso(candidateTime),
      });
      if (candidates.length >= maxConversations) {
        break;
      }
    }

    after = items[items.length - 1]?.id;
    if (
      candidates.length >= maxConversations ||
      reachedLookbackEnd ||
      items.length < CONVERSATION_LIST_PAGE_LIMIT ||
      !after
    ) {
      break;
    }
  }

  try {
    const defaultPage = await client.agents.messages.list(agentId, {
      conversation_id: "default",
      limit: 1,
      order: "desc",
    });
    const latestDefault = defaultPage.getPaginatedItems()[0];
    const defaultTimestamp = parseTimestamp(latestDefault?.date);
    if (
      defaultTimestamp !== null &&
      defaultTimestamp >= lookbackStartMs &&
      !seen.has("default")
    ) {
      candidates.push({
        conversationId: "default",
        lastMessagedAt: toIso(defaultTimestamp),
      });
    }
  } catch (error) {
    debugWarn(
      "memory",
      `Failed to inspect default conversation recency: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return candidates;
}

export async function collectReflectionSweepSegments(
  params: CollectReflectionSweepParams,
): Promise<ReflectionReviewSegment[]> {
  const {
    agentId,
    primaryConversationId,
    lookbackHours = DEFAULT_LOOKBACK_HOURS,
    idleMinutes = DEFAULT_IDLE_MINUTES,
    maxConversations = DEFAULT_MAX_CONVERSATIONS,
  } = params;
  const now = params.now ?? new Date();
  const nowMs = now.getTime();
  const lookbackStartMs = nowMs - lookbackHours * 60 * 60 * 1000;
  const idleCutoffMs = nowMs - idleMinutes * 60 * 1000;

  const client =
    params.client ?? ((await getClient()) as unknown as ReflectionReviewClient);
  const state = await readState(agentId);

  const candidates = await listRecentConversations(
    client,
    agentId,
    lookbackStartMs,
    maxConversations,
  );
  const segments: ReflectionReviewSegment[] = [];
  const latestConversationTimestamps = new Map<string, string>();

  for (const candidate of candidates) {
    const lastMessagedMs = parseTimestamp(candidate.lastMessagedAt);
    if (lastMessagedMs === null) {
      continue;
    }
    if (lastMessagedMs > idleCutoffMs) {
      continue;
    }

    const checkpoint = getCheckpoint(state, candidate.conversationId);
    checkpoint.last_messaged_at = candidate.lastMessagedAt;
    latestConversationTimestamps.set(
      candidate.conversationId,
      candidate.lastMessagedAt,
    );

    let messages: TranscriptMessage[] = [];
    if (checkpoint.last_reviewed_message_id) {
      try {
        messages = await fetchConversationMessagesAfter(
          client,
          agentId,
          candidate.conversationId,
          checkpoint.last_reviewed_message_id,
        );
      } catch {
        // Cursor may point to pruned messages. Fall back to recency window.
        messages = await fetchConversationMessagesSince(
          client,
          agentId,
          candidate.conversationId,
          lookbackStartMs,
        );
      }
    } else {
      messages = await fetchConversationMessagesSince(
        client,
        agentId,
        candidate.conversationId,
        lookbackStartMs,
      );
    }

    if (messages.length === 0) {
      continue;
    }

    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const startMessageId = firstMessage?.id;
    const endMessageId = lastMessage?.id;
    const startTimestamp = firstMessage?.date;
    const endTimestamp = lastMessage?.date;

    if (!startMessageId || !endMessageId || !startTimestamp || !endTimestamp) {
      continue;
    }

    const transcriptPath = buildTranscriptPath(candidate.conversationId);
    const transcript = serializeMessages(messages, {
      primaryConversationId,
      conversationId: candidate.conversationId,
      startMessageId,
      endMessageId,
      startTimestamp,
      endTimestamp,
    });
    await writeFile(transcriptPath, `${transcript}\n`, "utf-8");

    segments.push({
      agentId,
      primaryConversationId,
      conversationId: candidate.conversationId,
      transcriptPath,
      startMessageId,
      endMessageId,
      startTimestamp,
      endTimestamp,
      lastMessagedAt: candidate.lastMessagedAt,
      checkpointBefore: { ...checkpoint },
    });
  }

  if (latestConversationTimestamps.size > 0) {
    await queueStateUpdate(agentId, async () => {
      const latestState = await readState(agentId);
      for (const [
        conversationId,
        lastMessagedAt,
      ] of latestConversationTimestamps) {
        const checkpoint = getCheckpoint(latestState, conversationId);
        checkpoint.last_messaged_at = lastMessagedAt;
      }
      await writeState(agentId, latestState);
    });
  }

  return segments;
}

export async function logReflectionTrigger(
  agentId: string,
  entry: ReflectionTriggerLogEntry,
): Promise<void> {
  await appendTriggerLog(agentId, entry);
}

export async function finalizeReflectionSegmentReview(params: {
  agentId: string;
  segment: ReflectionReviewSegment;
  triggerSource: "step-count" | "compaction-event";
  success: boolean;
  reflectionAgentId: string | null;
  error?: string;
}): Promise<void> {
  await queueStateUpdate(params.agentId, async () => {
    const state = await readState(params.agentId);
    const checkpoint = getCheckpoint(state, params.segment.conversationId);

    checkpoint.last_messaged_at = params.segment.lastMessagedAt;
    checkpoint.reflection_agent_id = params.reflectionAgentId;

    if (params.success) {
      checkpoint.last_reviewed_message_id = params.segment.endMessageId;
      checkpoint.last_reviewed_timestamp = params.segment.endTimestamp;
    }

    await writeState(params.agentId, state);
  });

  await appendTriggerLog(params.agentId, {
    primary_agent_id: params.agentId,
    primary_conversation_id: params.segment.primaryConversationId,
    reviewed_conversation_id: params.segment.conversationId,
    starting_message_id: params.segment.startMessageId,
    ending_message_id: params.segment.endMessageId,
    reflection_agent_id: params.reflectionAgentId,
    starting_timestamp: params.segment.startTimestamp,
    ending_timestamp: params.segment.endTimestamp,
    trigger_source: params.triggerSource,
    status: params.success ? "completed" : "failed",
    ...(params.error ? { error: params.error } : {}),
  });

  debugLog(
    "memory",
    `Reflection ${params.success ? "completed" : "failed"} for ${params.segment.conversationId} (${params.segment.startMessageId}..${params.segment.endMessageId})`,
  );
}

export async function getReflectionReviewDebugInfo(
  agentId: string,
  conversationId: string,
): Promise<ReflectionReviewDebugInfo> {
  const paths = getStatePaths(agentId);
  const state = await readState(agentId);
  const checkpoint = getCheckpoint(state, conversationId);
  return {
    statePath: paths.statePath,
    triggerLogPath: paths.triggerLogPath,
    checkpoint,
  };
}
