import { randomUUID } from "node:crypto";
import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse,
} from "node:http";
import { getBackend } from "@/backend";
import { authorizeUpgrade } from "@/websocket/app-server-auth";
import {
  chatKeyFromHeaders,
  createConversationSerialized,
  extractTextContent,
  extractUserContentParts,
  getIdempotentOutcome,
  handleListModels,
  idempotencyKeyFromHeaders,
  type OpenAiChatMessage,
  type OpenAiCompatOptions,
  readJsonBody,
  rememberConversation,
  rememberIdempotentOutcome,
  resetOpenAiCompatState,
  resolveAgentForModel,
  resolveConversationId,
  sendJson,
  sendOpenAiError,
} from "@/websocket/app-server-openai-common";
import {
  handleResponses,
  RESPONSES_PATH,
} from "@/websocket/app-server-openai-responses";
import {
  type BridgeTurnMessage,
  runBridgeTurn,
  type TurnOutcome,
  type UserContentPart,
} from "@/websocket/app-server-openai-turn";

export { __testSetRunTurnImpl } from "@/websocket/app-server-openai-turn";

/** @internal Clears chat-key and idempotency maps between tests. */
export function __testResetConversationMap(): void {
  resetOpenAiCompatState();
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

export type { OpenAiCompatOptions } from "@/websocket/app-server-openai-common";

interface OpenAiChatCompletionRequest {
  model?: string;
  messages?: OpenAiChatMessage[];
  stream?: boolean;
}

export function isOpenAiCompatPath(pathname: string): boolean {
  return (
    pathname === MODELS_PATH ||
    pathname === CHAT_COMPLETIONS_PATH ||
    pathname === RESPONSES_PATH
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
  const headerChatKey = chatKeyFromHeaders(request, body.stream === true);
  const idempotencyHeader = idempotencyKeyFromHeaders(request);
  const idempotencyKey = idempotencyHeader
    ? `${agent.id}:${headerChatKey ?? ""}:${idempotencyHeader}`
    : null;
  // Consult the idempotency cache BEFORE any allocation: a replay must not
  // create (and orphan) a conversation for a turn that will never run.
  const replayPromise = idempotencyKey
    ? getIdempotentOutcome(idempotencyKey)
    : undefined;

  let conversationId: string | null = null;
  const turnMessages: BridgeTurnMessage[] = [];
  let correlationOtid: string | null = null;
  if (!replayPromise) {
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
      options.onLog?.(
        `OpenAI-compat failed to create conversation: ${message}`,
      );
      sendOpenAiError(
        response,
        500,
        "failed to create a conversation for this chat",
        "server_error",
      );
      return;
    }

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
    correlationOtid = turnMessages.at(-1)?.otid ?? null;
    if (!correlationOtid) {
      sendOpenAiError(
        response,
        400,
        "the messages array must include usable content",
        "invalid_request_error",
      );
      return;
    }
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
    let turnPromise = replayPromise;
    const ownsTurn = !turnPromise;
    if (!turnPromise) {
      turnPromise = runBridgeTurn({
        agentId: agent.id,
        conversationId: conversationId as string,
        messages: turnMessages,
        correlationOtid: correlationOtid as string,
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
  const usage = {
    prompt_tokens: outcome.usage.prompt_tokens,
    completion_tokens: outcome.usage.completion_tokens,
    total_tokens: outcome.usage.total_tokens,
    ...(outcome.usage.reasoning_tokens !== undefined
      ? {
          completion_tokens_details: {
            reasoning_tokens: outcome.usage.reasoning_tokens,
          },
        }
      : {}),
  };
  const streamError = outcome.error;

  // Headerless requests are stateless: their conversation exists only to
  // host this turn, so remove it best-effort once the turn has settled.
  // Header-keyed conversations persist — they ARE the chat's state.
  if (!headerChatKey && conversationId) {
    const ephemeralConversationId = conversationId;
    void getBackend()
      .deleteConversation?.(ephemeralConversationId)
      .catch(() => {
        options.onLog?.(
          `OpenAI-compat failed to delete ephemeral conversation ${ephemeralConversationId}`,
        );
      });
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
    if (pathname === RESPONSES_PATH && request.method === "POST") {
      await handleResponses(request, response, options);
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
