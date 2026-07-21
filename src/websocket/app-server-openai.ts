import { randomUUID } from "node:crypto";
import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse,
} from "node:http";
import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import {
  authorizeUpgrade,
  type WebsocketAuthPolicy,
} from "@/websocket/app-server-auth";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { dispatchInboundMessageWhenReady } from "@/websocket/listener/inbound-dispatch";
import { startLocalChannelListener } from "@/websocket/listener/lifecycle";
import { getOrCreateConversationPermissionModeStateRef } from "@/websocket/listener/permission-mode";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import {
  type ListenerTransport,
  LocalListenerTransport,
} from "@/websocket/listener/transport";
import { handleIncomingMessage } from "@/websocket/listener/turn";
import { registerTurnObserver } from "@/websocket/listener/turn-observers";
import type {
  IncomingMessage as ListenerIncomingMessage,
  ListenerRuntime,
  ListenerStreamObserver,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";

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

interface TurnOutcome {
  text: string;
  usage: OpenAiUsage;
  error: string | null;
}

interface BridgeTurnMessage {
  role: "user" | "assistant";
  content: UserContentPart[];
  otid: string;
}

interface RunTurnParams {
  agentId: string;
  conversationId: string;
  /** Full input for the turn: the newest message in stateful mode, or the
   * replayed client transcript in stateless mode. */
  messages: BridgeTurnMessage[];
  /** OTID of a message in this turn, used to correlate the listener turn
   * lifecycle with this request. */
  correlationOtid: string;
  onAssistantText?: (text: string) => void;
  onLog?: (message: string) => void;
}

type RunTurnImpl = (params: RunTurnParams) => Promise<TurnOutcome>;

let runTurnImpl: RunTurnImpl = runTurnViaListenerRuntime;

/** @internal Test seam mirroring __testSetBackend. */
export function __testSetRunTurnImpl(impl: RunTurnImpl | null): void {
  runTurnImpl = impl ?? runTurnViaListenerRuntime;
}

/** @internal Clears the transcript→conversation map between tests. */
export function __testResetConversationMap(): void {
  conversationIdByTranscript.clear();
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

type UserContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

interface OpenAiChatCompletionRequest {
  model?: string;
  messages?: OpenAiChatMessage[];
  stream?: boolean;
}

interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
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

// ---------------------------------------------------------------------------
// Turn execution over the listener v2 runtime.
//
// The bridge runs turns through the same dispatch path as WebSocket clients
// (queueing → turn processor → tools/mods/permissions) and observes the
// resulting v2 protocol stream via the runtime's in-process stream
// observers, converting chat-completions requests into protocol inputs and
// protocol events back into chat-completions outputs — the HTTP analogue of
// a messaging channel.
// ---------------------------------------------------------------------------

const OPENAI_TURN_TIMEOUT_MS = 15 * 60 * 1000;

const bridgeTransport = new LocalListenerTransport();
let bridgeRuntimeStart: Promise<void> | null = null;

/**
 * Reuse the active listener runtime when one exists (a connected WS control
 * session or channels runtime); otherwise start a socket-free local runtime,
 * exactly like `letta server --channels` does. If a WS control client
 * connects later it replaces the bridge-owned runtime, and subsequent
 * requests transparently use the new active runtime.
 */
async function ensureListenerRuntime(
  onLog?: (message: string) => void,
): Promise<ListenerRuntime> {
  const active = getActiveRuntime();
  if (active && !active.intentionallyClosed) return active;

  bridgeRuntimeStart ??= startLocalChannelListener({
    connectionId: `openai-api-${randomUUID()}`,
    deviceId: settingsManager.getOrCreateDeviceId(),
    connectionName: "openai-api",
    onConnected: () => {},
    onError: (error) => {
      onLog?.(`OpenAI-compat runtime error: ${error.message}`);
    },
  }).finally(() => {
    bridgeRuntimeStart = null;
  });
  await bridgeRuntimeStart;

  const runtime = getActiveRuntime();
  if (!runtime || runtime.intentionallyClosed) {
    throw new Error("failed to start listener runtime for OpenAI-compat API");
  }
  return runtime;
}

function extractDeltaText(delta: unknown): string {
  const content = (
    delta as { content?: string | Array<{ text?: string }> | null }
  ).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

async function runTurnViaListenerRuntime(
  params: RunTurnParams,
): Promise<TurnOutcome> {
  const listener = await ensureListenerRuntime(params.onLog);
  const scopedRuntime = getOrCreateScopedRuntime(
    listener,
    params.agentId,
    params.conversationId,
  );
  // No interactive approver exists on this surface, so bridge conversations
  // run unrestricted (Hermes-style: the API is opt-in and bearer-gated and
  // exposes the agent's full toolset). Approvals that still arise finish the
  // turn with an explanatory reply instead of hanging.
  getOrCreateConversationPermissionModeStateRef(
    listener,
    params.agentId,
    params.conversationId,
  ).mode = "unrestricted";
  // Frames emitted for this turn also flow to any attached WS client; the
  // transport here is only the fallback destination when none is attached.
  const socket: ListenerTransport =
    listener.socket ?? listener.transport ?? bridgeTransport;

  const dispatchOptions: StartListenerOptions = {
    connectionId: listener.connectionId ?? "openai-api",
    wsUrl: "",
    deviceId: settingsManager.getOrCreateDeviceId(),
    connectionName: listener.connectionName ?? "openai-api",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: (error) => {
      params.onLog?.(`OpenAI-compat turn error: ${error.message}`);
    },
  };

  const processQueuedTurn: ProcessQueuedTurn = async (
    queuedTurn,
    dequeuedBatch,
  ) => {
    const queuedScope = getOrCreateScopedRuntime(
      listener,
      queuedTurn.agentId,
      queuedTurn.conversationId,
    );
    await handleIncomingMessage(
      queuedTurn,
      socket,
      queuedScope,
      undefined,
      dispatchOptions.connectionId,
      dequeuedBatch.batchId,
    );
  };

  return await new Promise<TurnOutcome>((resolve) => {
    let text = "";
    let usage: OpenAiUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    // The request settles from ITS OWN turn's lifecycle (turn-observers,
    // keyed by OTID), never from raw stream events: stop_reason ends a
    // stream segment before the listener decides on retries/approvals, and
    // usage can arrive after it. Stream deltas are accumulated only while
    // this request's turn is active, so queued requests and WS-initiated
    // turns in the same conversation never bleed into this response.
    let turnActive = false;
    let recordedError: string | null = null;
    let settled = false;
    let unregisterTurnObserver: () => void = () => {};
    if (!listener.streamObservers) {
      listener.streamObservers = new Set();
    }
    const observers = listener.streamObservers;

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observers.delete(observer);
      unregisterTurnObserver();
      resolve({ text, usage, error });
    };

    const observer: ListenerStreamObserver = (message) => {
      if (message.type === "runtime_stopped") {
        finish(
          recordedError ??
            "server runtime was replaced while the request was in flight",
        );
        return;
      }
      if (message.runtime.agent_id !== params.agentId) return;
      if (message.runtime.conversation_id !== params.conversationId) return;
      if (!turnActive) return;
      if (message.type === "update_loop_status") {
        // The turn paused for interactive input this surface cannot provide.
        const status = (message as { loop_status?: { status?: string } })
          .loop_status?.status;
        if (status === "WAITING_ON_APPROVAL") {
          if (!text) {
            const note =
              "The agent attempted a tool call that requires interactive approval, which this API does not support.";
            text = note;
            params.onAssistantText?.(note);
          }
          finish(null);
        }
        return;
      }
      if (message.type !== "stream_delta" || message.subagent_id) return;
      const delta = (message as { delta?: { message_type?: string } }).delta;
      if (!delta) return;
      switch (delta.message_type) {
        case "assistant_message": {
          const piece = extractDeltaText(delta);
          if (piece) {
            text += piece;
            params.onAssistantText?.(piece);
          }
          return;
        }
        case "usage_statistics": {
          const stats = delta as {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
          usage = {
            prompt_tokens: stats.prompt_tokens ?? 0,
            completion_tokens: stats.completion_tokens ?? 0,
            total_tokens: stats.total_tokens ?? 0,
          };
          return;
        }
        case "loop_error": {
          // Recorded, not settled: the listener may still retry. The turn
          // lifecycle end decides the final outcome.
          const loopError = delta as {
            is_terminal?: boolean;
            message?: string;
          };
          if (loopError.is_terminal !== false) {
            recordedError = loopError.message ?? "agent turn failed";
          }
          return;
        }
        case "error_message":
          recordedError =
            (delta as { message?: string }).message ?? "agent turn failed";
          return;
        default:
          return;
      }
    };
    observers.add(observer);
    unregisterTurnObserver = registerTurnObserver(params.correlationOtid, {
      onStarted: () => {
        turnActive = true;
      },
      onFinished: () => {
        finish(recordedError);
      },
    });
    const timer = setTimeout(
      () => finish(recordedError ?? "agent turn timed out"),
      OPENAI_TURN_TIMEOUT_MS,
    );

    const incoming: ListenerIncomingMessage = {
      type: "message",
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: params.messages,
    };
    try {
      dispatchInboundMessageWhenReady({
        listener,
        runtime: scopedRuntime,
        incoming,
        socket,
        options: dispatchOptions,
        processQueuedTurn,
        processIncomingMessage: handleIncomingMessage,
        trackListenerError: (errorType, error) => {
          params.onLog?.(
            `OpenAI-compat listener error (${errorType}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
    }
  });
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

  let outcome: TurnOutcome;
  try {
    outcome = await runTurnImpl({
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
