import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse,
} from "node:http";
import { getBackend } from "@/backend";
import type { WebsocketAuthPolicy } from "@/websocket/app-server-auth";
import type {
  TurnOutcome,
  UserContentPart,
} from "@/websocket/app-server-openai-turn";

const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

export interface OpenAiCompatOptions {
  authPolicy: WebsocketAuthPolicy;
  onLog?: (message: string) => void;
}

export interface OpenAiChatMessagePart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

export interface OpenAiChatMessage {
  role?: string;
  content?: string | OpenAiChatMessagePart[] | null;
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function sendOpenAiError(
  response: ServerResponse,
  statusCode: number,
  message: string,
  type: string,
  code: string | null = null,
): void {
  sendJson(response, statusCode, {
    error: { message, type, param: null, code },
  });
}

export async function readJsonBody(
  request: HttpIncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

export function extractTextContent(
  content: string | OpenAiChatMessagePart[] | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      (part.type === "text" ||
        part.type === "input_text" ||
        part.type === "output_text") &&
      typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

const IMAGE_DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/;

function toImagePart(rawUrl: string): UserContentPart | null {
  const match = IMAGE_DATA_URL_RE.exec(rawUrl);
  if (match?.[1] && match[2]) {
    return {
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    };
  }
  if (/^https?:\/\//.test(rawUrl)) {
    return { type: "image", source: { type: "url", url: rawUrl } };
  }
  return null;
}

/** OpenAI user content → Letta content parts (text and image_url). */
export function extractUserContentParts(
  content: string | OpenAiChatMessagePart[] | null | undefined,
): UserContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: UserContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (
      (part.type === "text" || part.type === "input_text") &&
      typeof part.text === "string" &&
      part.text
    ) {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const raw =
        typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;
      if (typeof raw === "string") {
        const image = toImagePart(raw);
        if (image) parts.push(image);
      }
    }
  }
  return parts;
}

function toModelCreatedTimestamp(createdAt: unknown): number {
  if (typeof createdAt === "string") {
    const ms = new Date(createdAt).getTime();
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return 0;
}

export interface AgentModelEntry {
  id: string;
  name?: string | null;
  created_at?: string;
}

function getPageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
    if (Array.isArray(candidate.items)) {
      return candidate.items;
    }
  }
  return [];
}

const MAX_LISTED_AGENTS = 1000;

async function listAgentEntries(): Promise<AgentModelEntry[]> {
  const page = await getBackend().listAgents({ limit: MAX_LISTED_AGENTS });
  if (Array.isArray(page)) return page as AgentModelEntry[];
  // SDK pages are async-iterable across ALL pages; a first-page-only read
  // silently drops agents once the list exceeds one page.
  const iterable = page as unknown as {
    [Symbol.asyncIterator]?: () => AsyncIterator<AgentModelEntry>;
  };
  if (typeof iterable[Symbol.asyncIterator] === "function") {
    const items: AgentModelEntry[] = [];
    for await (const item of iterable as AsyncIterable<AgentModelEntry>) {
      items.push(item);
      if (items.length >= MAX_LISTED_AGENTS) break;
    }
    return items;
  }
  return getPageItems<AgentModelEntry>(page);
}

/**
 * One collision-free advertised-id map, used by both listing and
 * resolution. An agent name is advertised only when it is unique among
 * names AND does not equal any agent id — otherwise the agent id is
 * advertised — so every advertised id resolves to exactly one agent and
 * raw agent-id lookups can never be shadowed by another agent's name.
 */
function buildAdvertisedModelMap(
  agents: AgentModelEntry[],
): Map<string, AgentModelEntry> {
  const ids = new Set(agents.map((agent) => agent.id));
  const nameCounts = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.name) continue;
    nameCounts.set(agent.name, (nameCounts.get(agent.name) ?? 0) + 1);
  }
  const advertised = new Map<string, AgentModelEntry>();
  for (const agent of agents) {
    const useName =
      agent.name && nameCounts.get(agent.name) === 1 && !ids.has(agent.name);
    const id = useName && agent.name ? agent.name : agent.id;
    if (!advertised.has(id)) advertised.set(id, agent);
  }
  return advertised;
}

export async function handleListModels(
  response: ServerResponse,
): Promise<void> {
  const advertised = buildAdvertisedModelMap(await listAgentEntries());
  const data = [...advertised.entries()].map(([id, agent]) => ({
    id,
    object: "model" as const,
    created: toModelCreatedTimestamp(agent.created_at),
    owned_by: "letta",
  }));
  sendJson(response, 200, { object: "list", data });
}

export async function resolveAgentForModel(
  model: string,
): Promise<AgentModelEntry | null> {
  const agents = await listAgentEntries();
  return (
    buildAdvertisedModelMap(agents).get(model) ??
    agents.find((agent) => agent.id === model) ??
    null
  );
}

// Conversation continuity for header-keyed chats. Clients that supply a
// stable chat identity get a pinned Letta conversation; the bounded FIFO
// map evicts long-idle chats, which then start a fresh conversation.
const MAX_TRACKED_TRANSCRIPTS = 4096;
const conversationIdByTranscript = new Map<string, string>();

export function rememberConversation(
  key: string,
  conversationId: string,
): void {
  conversationIdByTranscript.delete(key);
  conversationIdByTranscript.set(key, conversationId);
  while (conversationIdByTranscript.size > MAX_TRACKED_TRANSCRIPTS) {
    const oldest = conversationIdByTranscript.keys().next().value;
    if (oldest === undefined) break;
    conversationIdByTranscript.delete(oldest);
  }
}

// Conversation creation is serialized per agent: concurrent creations race
// on initializing the agent's local memory repository (transient git config
// lock failures). Failures propagate to the caller as a 500 — routing into
// the shared "default" conversation instead would cross-wire client chats.
const conversationCreateTailByAgent = new Map<string, Promise<void>>();
const CONVERSATION_CREATE_RETRIES = 2;
const CONVERSATION_CREATE_RETRY_DELAY_MS = 200;

async function createConversationWithRetry(agentId: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CONVERSATION_CREATE_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONVERSATION_CREATE_RETRY_DELAY_MS * attempt),
      );
    }
    try {
      const conversation = await getBackend().createConversation({
        agent_id: agentId,
      });
      return conversation.id;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Serialized per-agent conversation creation (see note above). The
 * optional reuseKey is re-checked after the queue drains so a concurrent
 * request with the same key reuses the conversation it created. */
export async function createConversationSerialized(
  agentId: string,
  reuseKey?: string,
): Promise<string> {
  const tail = conversationCreateTailByAgent.get(agentId) ?? Promise.resolve();
  const creation = tail.then(async () => {
    if (reuseKey) {
      const raced = conversationIdByTranscript.get(reuseKey);
      if (raced) return raced;
    }
    return await createConversationWithRetry(agentId);
  });
  const settled = creation.then(
    () => undefined,
    () => undefined,
  );
  conversationCreateTailByAgent.set(agentId, settled);
  void settled.then(() => {
    if (conversationCreateTailByAgent.get(agentId) === settled) {
      conversationCreateTailByAgent.delete(agentId);
    }
  });
  return await creation;
}

export async function resolveConversationId(
  agentId: string,
  chatKey: string,
): Promise<string> {
  const existing = conversationIdByTranscript.get(chatKey);
  if (existing) return existing;
  return await createConversationSerialized(agentId, chatKey);
}

// Clients that know their chat identity can pin it explicitly instead of
// relying on transcript fingerprints, which collide when two chats have
// byte-identical transcripts (e.g. both start "Hello" and get the same
// verbatim reply). Open WebUI sends X-OpenWebUI-Chat-Id when
// ENABLE_FORWARD_USER_INFO_HEADERS is on; X-Letta-Chat-Key is the generic
// escape hatch for other clients.
function headerValue(
  request: HttpIncomingMessage,
  name: string,
): string | null {
  const value = request.headers[name];
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value[0]) return value[0];
  return null;
}

/**
 * X-Letta-Chat-Key always pins chat identity. X-OpenWebUI-Chat-Id is
 * honored only for streaming requests: Open WebUI's real chat messages
 * always stream, while its background task requests (title/tags/follow-up
 * generation) are non-streaming yet carry the same chat id — honoring
 * those would route task prompts into the user's pinned conversation.
 */
export function chatKeyFromHeaders(
  request: HttpIncomingMessage,
  streaming: boolean,
): string | null {
  const explicit = headerValue(request, "x-letta-chat-key");
  if (explicit) return explicit;
  if (!streaming) return null;
  return openWebUiChatIdFromHeaders(request);
}

export function openWebUiChatIdFromHeaders(
  request: HttpIncomingMessage,
): string | null {
  return headerValue(request, "x-openwebui-chat-id");
}

// Retry idempotency: a client retry carrying the same Idempotency-Key
// reuses the original request's outcome instead of running (and appending)
// the message again. In-flight duplicates share the same turn; failed
// outcomes are evicted so an intentional retry after an error re-runs.
const IDEMPOTENCY_HEADERS = ["idempotency-key", "x-idempotency-key"] as const;
const MAX_IDEMPOTENT_OUTCOMES = 1024;
const outcomeByIdempotencyKey = new Map<string, Promise<TurnOutcome>>();

export function idempotencyKeyFromHeaders(
  request: HttpIncomingMessage,
): string | null {
  for (const name of IDEMPOTENCY_HEADERS) {
    const value = headerValue(request, name);
    if (value) return value;
  }
  return null;
}

export function rememberIdempotentOutcome(
  key: string,
  promise: Promise<TurnOutcome>,
): void {
  outcomeByIdempotencyKey.delete(key);
  outcomeByIdempotencyKey.set(key, promise);
  while (outcomeByIdempotencyKey.size > MAX_IDEMPOTENT_OUTCOMES) {
    const oldest = outcomeByIdempotencyKey.keys().next().value;
    if (oldest === undefined) break;
    outcomeByIdempotencyKey.delete(oldest);
  }
  const evict = () => {
    if (outcomeByIdempotencyKey.get(key) === promise) {
      outcomeByIdempotencyKey.delete(key);
    }
  };
  promise.then((outcome) => {
    if (outcome.error) evict();
  }, evict);
}

export function getIdempotentOutcome(
  key: string,
): Promise<TurnOutcome> | undefined {
  return outcomeByIdempotencyKey.get(key);
}

/** @internal Clears chat-key and idempotency maps between tests. */
export function resetOpenAiCompatState(): void {
  conversationIdByTranscript.clear();
  outcomeByIdempotencyKey.clear();
}
