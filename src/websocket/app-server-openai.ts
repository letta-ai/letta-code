import { randomUUID } from "node:crypto";
import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse,
} from "node:http";
import { getBackend } from "@/backend";
import {
  authorizeUpgrade,
  type WebsocketAuthPolicy,
} from "@/websocket/app-server-auth";
import {
  type BridgeTurnMessage,
  runBridgeTurn,
  type TurnOutcome,
  type UserContentPart,
} from "@/websocket/app-server-openai-turn";

export { __testSetRunTurnImpl } from "@/websocket/app-server-openai-turn";

/** @internal Clears chat-key and idempotency maps between tests. */
export function __testResetConversationMap(): void {
  conversationIdByTranscript.clear();
  outcomeByIdempotencyKey.clear();
}

// OpenAI-compatible surface for the App Server. Each Letta agent is
// advertised as a "model". Conversation identity is explicit or absent:
// clients that send a stable chat id header get a pinned Letta conversation
// that receives only the newest message (stateful mode); header-less clients
// are served statelessly — every request runs in a fresh conversation with
// the client's transcript replayed — because identical transcripts are
// indistinguishable and transcript fingerprinting cross-wires them.
const MODELS_PATH = "/v1/models";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

export interface OpenAiCompatOptions {
  authPolicy: WebsocketAuthPolicy;
  onLog?: (message: string) => void;
}

interface OpenAiChatMessagePart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

interface OpenAiChatMessage {
  role?: string;
  content?: string | OpenAiChatMessagePart[] | null;
}

interface OpenAiChatCompletionRequest {
  model?: string;
  messages?: OpenAiChatMessage[];
  stream?: boolean;
}

export function isOpenAiCompatPath(pathname: string): boolean {
  return pathname === MODELS_PATH || pathname === CHAT_COMPLETIONS_PATH;
}

function sendJson(
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

function sendOpenAiError(
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

async function readJsonBody(request: HttpIncomingMessage): Promise<unknown> {
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

function extractTextContent(
  content: string | OpenAiChatMessagePart[] | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && part.type === "text" && typeof part.text === "string"
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
function extractUserContentParts(
  content: string | OpenAiChatMessagePart[] | null | undefined,
): UserContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: UserContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string" && part.text) {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image_url") {
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

interface AgentModelEntry {
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

async function listAgentEntries(): Promise<AgentModelEntry[]> {
  const page = await getBackend().listAgents({});
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

async function handleListModels(response: ServerResponse): Promise<void> {
  const advertised = buildAdvertisedModelMap(await listAgentEntries());
  const data = [...advertised.entries()].map(([id, agent]) => ({
    id,
    object: "model" as const,
    created: toModelCreatedTimestamp(agent.created_at),
    owned_by: "letta",
  }));
  sendJson(response, 200, { object: "list", data });
}

async function resolveAgentForModel(
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

function rememberConversation(key: string, conversationId: string): void {
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
async function createConversationSerialized(
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

async function resolveConversationId(
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
const CHAT_KEY_HEADERS = ["x-letta-chat-key", "x-openwebui-chat-id"] as const;

function chatKeyFromHeaders(request: HttpIncomingMessage): string | null {
  for (const name of CHAT_KEY_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return null;
}

// Retry idempotency: a client retry carrying the same Idempotency-Key
// reuses the original request's outcome instead of running (and appending)
// the message again. In-flight duplicates share the same turn; failed
// outcomes are evicted so an intentional retry after an error re-runs.
const IDEMPOTENCY_HEADERS = ["idempotency-key", "x-idempotency-key"] as const;
const MAX_IDEMPOTENT_OUTCOMES = 1024;
const outcomeByIdempotencyKey = new Map<string, Promise<TurnOutcome>>();

function idempotencyKeyFromHeaders(
  request: HttpIncomingMessage,
): string | null {
  for (const name of IDEMPOTENCY_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string" && value) return value;
    if (Array.isArray(value) && value[0]) return value[0];
  }
  return null;
}

function rememberIdempotentOutcome(
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

function chatCompletionChunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function handleChatCompletions(
  request: HttpIncomingMessage,
  response: ServerResponse,
  options: OpenAiCompatOptions,
): Promise<void> {
  let body: OpenAiChatCompletionRequest;
  try {
    body = (await readJsonBody(request)) as OpenAiChatCompletionRequest;
  } catch (error) {
    sendOpenAiError(
      response,
      400,
      error instanceof Error ? error.message : "invalid JSON body",
      "invalid_request_error",
    );
    return;
  }

  if (typeof body.model !== "string" || body.model.length === 0) {
    sendOpenAiError(
      response,
      400,
      "you must provide a model parameter",
      "invalid_request_error",
    );
    return;
  }
  const model = body.model;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    sendOpenAiError(
      response,
      400,
      "you must provide a non-empty messages array",
      "invalid_request_error",
    );
    return;
  }

  const lastUserMessage = [...body.messages]
    .reverse()
    .find((message) => message.role === "user");
  const userContent = extractUserContentParts(lastUserMessage?.content);
  if (userContent.length === 0) {
    sendOpenAiError(
      response,
      400,
      "the messages array must include a user message with text or image content",
      "invalid_request_error",
    );
    return;
  }

  const agent = await resolveAgentForModel(model);
  if (!agent) {
    sendOpenAiError(
      response,
      404,
      `The model '${model}' does not exist. Use GET /v1/models to list available agents.`,
      "invalid_request_error",
      "model_not_found",
    );
    return;
  }

  // Stateful mode requires a stable chat identity from the client; without
  // one, identical transcripts are indistinguishable and any reuse
  // heuristic can cross-wire chats. Header-less requests run statelessly:
  // a fresh conversation per request, with the client transcript replayed.
  const headerChatKey = chatKeyFromHeaders(request);
  let conversationId: string;
  try {
    if (headerChatKey) {
      const chatKey = `chat-key:${agent.id}:${headerChatKey}`;
      conversationId = await resolveConversationId(agent.id, chatKey);
      // Pin immediately so concurrent requests for this chat reuse it.
      rememberConversation(chatKey, conversationId);
    } else {
      conversationId = await createConversationSerialized(agent.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.(`OpenAI-compat failed to create conversation: ${message}`);
    sendOpenAiError(
      response,
      500,
      "failed to create a conversation for this chat",
      "server_error",
    );
    return;
  }

  const turnMessages: BridgeTurnMessage[] = [];
  if (headerChatKey) {
    turnMessages.push({
      role: "user",
      content: userContent,
      otid: randomUUID(),
    });
  } else {
    for (const message of body.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      let content: UserContentPart[];
      if (message === lastUserMessage) {
        content = userContent;
      } else if (message.role === "user") {
        content = extractUserContentParts(message.content);
      } else {
        const replyText = extractTextContent(message.content);
        content = replyText ? [{ type: "text", text: replyText }] : [];
      }
      if (content.length === 0) continue;
      turnMessages.push({ role: message.role, content, otid: randomUUID() });
    }
  }
  const correlationOtid = turnMessages.at(-1)?.otid;
  if (!correlationOtid) {
    sendOpenAiError(
      response,
      400,
      "the messages array must include usable content",
      "invalid_request_error",
    );
    return;
  }

  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const streaming = body.stream === true;
  let clientClosed = false;
  response.on("close", () => {
    clientClosed = true;
  });

  if (streaming) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      chatCompletionChunk(
        completionId,
        created,
        model,
        { role: "assistant", content: "" },
        null,
      ),
    );
  }

  const idempotencyHeader = idempotencyKeyFromHeaders(request);
  const idempotencyKey = idempotencyHeader
    ? `${agent.id}:${headerChatKey ?? ""}:${idempotencyHeader}`
    : null;

  let outcome: TurnOutcome;
  try {
    let turnPromise = idempotencyKey
      ? outcomeByIdempotencyKey.get(idempotencyKey)
      : undefined;
    const ownsTurn = !turnPromise;
    if (!turnPromise) {
      turnPromise = runBridgeTurn({
        agentId: agent.id,
        conversationId,
        messages: turnMessages,
        correlationOtid,
        onLog: options.onLog,
        onAssistantText: streaming
          ? (piece) => {
              if (clientClosed) return;
              response.write(
                chatCompletionChunk(
                  completionId,
                  created,
                  model,
                  { content: piece },
                  null,
                ),
              );
            }
          : undefined,
      });
      if (idempotencyKey) {
        rememberIdempotentOutcome(idempotencyKey, turnPromise);
      }
    }
    outcome = await turnPromise;
    // Replayed outcomes stream their text as one chunk: the incremental
    // pieces went to the original request's response.
    if (!ownsTurn && streaming && outcome.text && !clientClosed) {
      response.write(
        chatCompletionChunk(
          completionId,
          created,
          model,
          { content: outcome.text },
          null,
        ),
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.(`OpenAI-compat chat completion failed: ${message}`);
    outcome = {
      text: "",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: "failed to run agent turn",
    };
  }
  const fullText = outcome.text;
  const usage = outcome.usage;
  const streamError = outcome.error;

  if (clientClosed) return;

  if (streaming) {
    if (streamError) {
      options.onLog?.(`OpenAI-compat stream error: ${streamError}`);
      response.write(
        `data: ${JSON.stringify({
          error: { message: streamError, type: "server_error" },
        })}\n\n`,
      );
    } else {
      response.write(
        chatCompletionChunk(completionId, created, model, {}, "stop"),
      );
    }
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  if (streamError) {
    options.onLog?.(`OpenAI-compat stream error: ${streamError}`);
    sendOpenAiError(response, 500, streamError, "server_error");
    return;
  }

  sendJson(response, 200, {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: fullText },
        finish_reason: "stop",
      },
    ],
    usage,
  });
}

export async function handleOpenAiCompatRequest(
  request: HttpIncomingMessage,
  response: ServerResponse,
  options: OpenAiCompatOptions,
): Promise<void> {
  const authError = authorizeUpgrade(request.headers, options.authPolicy);
  if (authError) {
    options.onLog?.(`Rejecting OpenAI-compat request: ${authError.message}`);
    sendOpenAiError(response, 401, authError.message, "authentication_error");
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    if (pathname === MODELS_PATH && request.method === "GET") {
      await handleListModels(response);
      return;
    }
    if (pathname === CHAT_COMPLETIONS_PATH && request.method === "POST") {
      await handleChatCompletions(request, response, options);
      return;
    }
    sendOpenAiError(response, 404, "unknown endpoint", "invalid_request_error");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.(`OpenAI-compat request failed: ${message}`);
    if (!response.headersSent) {
      sendOpenAiError(response, 500, message, "server_error");
    } else {
      response.end();
    }
  }
}
