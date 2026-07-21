import { createHash, randomUUID } from "node:crypto";
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
import type {
  IncomingMessage as ListenerIncomingMessage,
  ListenerRuntime,
  ListenerStreamObserver,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";

// OpenAI-compatible surface for the App Server. Each Letta agent is
// advertised as a "model"; a chat completion request routes the last user
// message into a Letta conversation on that agent. The resent client-side
// history is not replayed into the agent — server-side state is
// authoritative — but it IS used as a fingerprint to keep each client-side
// chat pinned to its own Letta conversation across stateless requests.
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

interface RunTurnParams {
  agentId: string;
  conversationId: string;
  userContent: UserContentPart[];
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

async function handleListModels(response: ServerResponse): Promise<void> {
  const agents = await listAgentEntries();
  // Advertise the agent name when it is unambiguous; fall back to the agent
  // id for duplicate names so every listed model id resolves to one agent.
  const nameCounts = new Map<string, number>();
  for (const agent of agents) {
    if (!agent.name) continue;
    nameCounts.set(agent.name, (nameCounts.get(agent.name) ?? 0) + 1);
  }
  const data = agents.map((agent) => ({
    id: agent.name && nameCounts.get(agent.name) === 1 ? agent.name : agent.id,
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
    agents.find((agent) => agent.id === model) ??
    agents.find((agent) => agent.name === model) ??
    null
  );
}

// Conversation continuity across stateless chat-completions requests.
// The protocol carries no thread id, so a client chat is identified by a
// fingerprint of its transcript prefix (the user/assistant turns before
// the message being sent). A first message has an empty prefix and starts
// a fresh Letta conversation; after each completed turn we also store the
// fingerprint of the transcript including the new reply, which is exactly
// the prefix the client will resend on its next message in that chat.
// Bounded FIFO map: long-idle chats fall out and start a new conversation.
const MAX_TRACKED_TRANSCRIPTS = 4096;
const conversationIdByTranscript = new Map<string, string>();

interface TranscriptTurn {
  role: string;
  text: string;
}

function rememberConversation(key: string, conversationId: string): void {
  conversationIdByTranscript.delete(key);
  conversationIdByTranscript.set(key, conversationId);
  while (conversationIdByTranscript.size > MAX_TRACKED_TRANSCRIPTS) {
    const oldest = conversationIdByTranscript.keys().next().value;
    if (oldest === undefined) break;
    conversationIdByTranscript.delete(oldest);
  }
}

function transcriptFingerprint(
  agentId: string,
  turns: TranscriptTurn[],
): string {
  const hash = createHash("sha256");
  hash.update(agentId);
  for (const turn of turns) {
    hash.update("\0");
    hash.update(turn.role);
    hash.update("\0");
    hash.update(turn.text);
  }
  return hash.digest("hex");
}

/** User/assistant turns with text content, in order; system turns are
 * excluded because clients vary them independently of the thread. */
function normalizeTranscript(messages: OpenAiChatMessage[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    turns.push({
      role: message.role,
      text: extractTextContent(message.content),
    });
  }
  return turns;
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

async function resolveConversationId(
  agentId: string,
  prefixKey: string,
): Promise<string> {
  const existing = conversationIdByTranscript.get(prefixKey);
  if (existing) return existing;
  const tail = conversationCreateTailByAgent.get(agentId) ?? Promise.resolve();
  const creation = tail.then(async () => {
    // Re-check after the queue drains: a concurrent request with the same
    // key (e.g. a double-send from a header-keyed chat) may have created
    // and remembered the conversation while this one waited.
    const raced = conversationIdByTranscript.get(prefixKey);
    if (raced) return raced;
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
    let settled = false;
    if (!listener.streamObservers) {
      listener.streamObservers = new Set();
    }
    const observers = listener.streamObservers;

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      observers.delete(observer);
      resolve({ text, usage, error });
    };

    const observer: ListenerStreamObserver = (message) => {
      if (message.runtime.agent_id !== params.agentId) return;
      if (message.runtime.conversation_id !== params.conversationId) return;
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
        case "stop_reason": {
          const stopReason = (delta as { stop_reason?: string }).stop_reason;
          // requires_approval ends a stream segment, not the turn: the turn
          // processor evaluates the approval (auto-approving under the
          // conversation's permission mode) and continues. Keep observing;
          // a WAITING_ON_APPROVAL loop status marks a truly stuck turn.
          if (stopReason === "requires_approval") return;
          finish(null);
          return;
        }
        case "loop_error": {
          const loopError = delta as {
            is_terminal?: boolean;
            message?: string;
          };
          if (loopError.is_terminal !== false) {
            finish(loopError.message ?? "agent turn failed");
          }
          return;
        }
        case "error_message":
          finish(
            (delta as { message?: string }).message ?? "agent turn failed",
          );
          return;
        default:
          return;
      }
    };
    observers.add(observer);
    const timer = setTimeout(
      () => finish("agent turn timed out"),
      OPENAI_TURN_TIMEOUT_MS,
    );

    const incoming: ListenerIncomingMessage = {
      type: "message",
      agentId: params.agentId,
      conversationId: params.conversationId,
      messages: [
        {
          role: "user",
          content: params.userContent,
          otid: randomUUID(),
        },
      ],
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

  const transcript = normalizeTranscript(body.messages);
  const lastUserIndex = transcript.findLastIndex(
    (turn) => turn.role === "user",
  );
  const userText =
    (lastUserIndex >= 0 && transcript[lastUserIndex]?.text) || "";
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

  const prefixTurns = transcript.slice(0, lastUserIndex);
  const headerChatKey = chatKeyFromHeaders(request);
  const prefixKey = headerChatKey
    ? `chat-key:${agent.id}:${headerChatKey}`
    : transcriptFingerprint(agent.id, prefixTurns);
  let conversationId: string;
  try {
    conversationId = await resolveConversationId(agent.id, prefixKey);
    if (headerChatKey) {
      // Header keys are stable chat identities: pin them immediately so a
      // concurrent request for the same chat reuses this conversation.
      rememberConversation(prefixKey, conversationId);
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
      userContent,
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

  if (!streamError) {
    // Map the prefix itself (so a regenerate of the same message reuses
    // this conversation) and the transcript including the new reply (the
    // prefix the client resends on its next message in this chat). The
    // EMPTY prefix is shared by every brand-new chat and must never be
    // remembered — doing so would funnel all new chats into one
    // conversation. Header-keyed chats are already pinned by their stable
    // key and skip transcript bookkeeping entirely.
    if (headerChatKey) {
      rememberConversation(prefixKey, conversationId);
    } else {
      if (prefixTurns.length > 0) {
        rememberConversation(prefixKey, conversationId);
      }
      rememberConversation(
        transcriptFingerprint(agent.id, [
          ...prefixTurns,
          { role: "user", text: userText },
          { role: "assistant", text: fullText },
        ]),
        conversationId,
      );
    }
  }

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
