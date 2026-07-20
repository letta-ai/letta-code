import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { sendMessageStream } from "@/agent/message";
import { getBackend } from "@/backend";
import {
  authorizeUpgrade,
  type WebsocketAuthPolicy,
} from "@/websocket/app-server-auth";

// OpenAI-compatible surface for the App Server. Each Letta agent is
// advertised as a "model"; a chat completion request routes the last user
// message into that agent's default conversation. The resent client-side
// history is intentionally ignored — the agent's own server-side memory and
// conversation state are authoritative.
const MODELS_PATH = "/v1/models";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

export interface OpenAiCompatOptions {
  authPolicy: WebsocketAuthPolicy;
  onLog?: (message: string) => void;
}

type SendMessageStreamImpl = (
  ...args: Parameters<typeof sendMessageStream>
) => Promise<AsyncIterable<LettaStreamingResponse>>;

let sendMessageStreamImpl: SendMessageStreamImpl = sendMessageStream;

/** @internal Test seam mirroring __testSetBackend. */
export function __testSetSendMessageStreamImpl(
  impl: SendMessageStreamImpl | null,
): void {
  sendMessageStreamImpl = impl ?? sendMessageStream;
}

interface OpenAiChatMessagePart {
  type?: string;
  text?: string;
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
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

function extractAssistantText(chunk: LettaStreamingResponse): string {
  const content = (
    chunk as { content?: string | Array<{ text?: string }> | null }
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
  request: IncomingMessage,
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
  const userText = extractTextContent(lastUserMessage?.content);
  if (!userText) {
    sendOpenAiError(
      response,
      400,
      "the messages array must include a user message with text content",
      "invalid_request_error",
    );
    return;
  }

  const agent = await resolveAgentForModel(body.model);
  if (!agent) {
    sendOpenAiError(
      response,
      404,
      `The model '${body.model}' does not exist. Use GET /v1/models to list available agents.`,
      "invalid_request_error",
      "model_not_found",
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

  let stream: AsyncIterable<LettaStreamingResponse>;
  try {
    stream = await sendMessageStreamImpl(
      "default",
      [
        {
          role: "user",
          content: [{ type: "text", text: userText }],
          otid: randomUUID(),
        },
      ],
      { agentId: agent.id, streamTokens: true, background: true },
    );
  } catch (error) {
    options.onLog?.(
      `OpenAI-compat chat completion failed to start: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    sendOpenAiError(
      response,
      500,
      "failed to start agent turn",
      "server_error",
    );
    return;
  }

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
        body.model,
        { role: "assistant", content: "" },
        null,
      ),
    );
  }

  let fullText = "";
  let usage: OpenAiUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  let streamError: string | null = null;

  try {
    for await (const chunk of stream) {
      if (clientClosed) break;
      const messageType = (chunk as { message_type?: string }).message_type;
      if (messageType === "assistant_message") {
        const text = extractAssistantText(chunk);
        if (!text) continue;
        fullText += text;
        if (streaming) {
          response.write(
            chatCompletionChunk(
              completionId,
              created,
              body.model,
              { content: text },
              null,
            ),
          );
        }
      } else if (messageType === "usage_statistics") {
        const stats = chunk as {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        usage = {
          prompt_tokens: stats.prompt_tokens ?? 0,
          completion_tokens: stats.completion_tokens ?? 0,
          total_tokens: stats.total_tokens ?? 0,
        };
      } else if (messageType === "error_message") {
        streamError =
          (chunk as { message?: string }).message ?? "agent turn failed";
        break;
      } else if (messageType === "stop_reason") {
        break;
      }
    }
  } catch (error) {
    streamError = error instanceof Error ? error.message : String(error);
  }

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
        chatCompletionChunk(completionId, created, body.model, {}, "stop"),
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
    model: body.model,
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
  request: IncomingMessage,
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
