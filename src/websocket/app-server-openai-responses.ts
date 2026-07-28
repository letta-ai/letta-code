import { randomUUID } from "node:crypto";
import type {
  IncomingMessage as HttpIncomingMessage,
  ServerResponse,
} from "node:http";
import { getBackend } from "@/backend";
import {
  chatKeyFromHeaders,
  createConversationSerialized,
  extractTextContent,
  extractUserContentParts,
  type OpenAiChatMessage,
  type OpenAiCompatOptions,
  readJsonBody,
  rememberConversation,
  resolveAgentForModel,
  resolveConversationId,
  sendJson,
  sendOpenAiError,
} from "@/websocket/app-server-openai-common";
import type { ToolCallEvent } from "@/websocket/app-server-openai-tools";
import {
  type BridgeTurnMessage,
  runBridgeTurn,
  type TurnOutcome,
  type UserContentPart,
} from "@/websocket/app-server-openai-turn";

export const RESPONSES_PATH = "/v1/responses";

interface ResponsesContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[] | null;
}

interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string | null;
  previous_response_id?: string | null;
  store?: boolean;
  stream?: boolean;
}

interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "failed";
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  id: string;
  call_id: string;
  output: Array<{ type: "input_text"; text: string }>;
  status: "completed" | "failed";
}

interface MessageItem {
  type: "message";
  id: string;
  status: "in_progress" | "completed";
  role: "assistant";
  content: Array<{
    type: "output_text";
    text: string;
    annotations: unknown[];
  }>;
}

type ResponseOutputItem =
  | FunctionCallItem
  | FunctionCallOutputItem
  | MessageItem;

interface StoredResponseState {
  agentId: string;
  conversationId: string;
}

const MAX_STORED_RESPONSES = 4096;
const storedResponseState = new Map<string, StoredResponseState>();

/** @internal Reset Responses API state between tests. */
export function resetResponsesState(): void {
  storedResponseState.clear();
}

function rememberResponseState(
  responseId: string,
  state: StoredResponseState,
): void {
  storedResponseState.delete(responseId);
  storedResponseState.set(responseId, state);
  while (storedResponseState.size > MAX_STORED_RESPONSES) {
    const oldest = storedResponseState.keys().next().value;
    if (oldest === undefined) break;
    storedResponseState.delete(oldest);
  }
}

function normalizeInput(input: ResponsesRequest["input"]): OpenAiChatMessage[] {
  if (typeof input === "string") {
    return input ? [{ role: "user", content: input }] : [];
  }
  if (!Array.isArray(input)) return [];
  const messages: OpenAiChatMessage[] = [];
  for (const item of input) {
    if (!item || item.type !== "message") continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

function toBridgeMessages(
  messages: OpenAiChatMessage[],
  stateful: boolean,
): { messages: BridgeTurnMessage[]; correlationOtid: string | null } {
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const lastUserContent = extractUserContentParts(lastUserMessage?.content);
  if (lastUserContent.length === 0) {
    return { messages: [], correlationOtid: null };
  }

  if (stateful) {
    const otid = randomUUID();
    return {
      messages: [{ role: "user", content: lastUserContent, otid }],
      correlationOtid: otid,
    };
  }

  const bridgeMessages: BridgeTurnMessage[] = [];
  for (const message of messages) {
    let content: UserContentPart[];
    if (message === lastUserMessage) {
      content = lastUserContent;
    } else if (message.role === "user") {
      content = extractUserContentParts(message.content);
    } else {
      const text = extractTextContent(message.content);
      content = text ? [{ type: "text", text }] : [];
    }
    if (content.length === 0) continue;
    bridgeMessages.push({
      role: message.role as "user" | "assistant",
      content,
      otid: randomUUID(),
    });
  }
  return {
    messages: bridgeMessages,
    correlationOtid: bridgeMessages.at(-1)?.otid ?? null,
  };
}

function responseUsage(usage: TurnOutcome["usage"]): Record<string, number> {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

function makeResponse(
  responseId: string,
  createdAt: number,
  model: string,
  status: "in_progress" | "completed" | "failed",
  output: ResponseOutputItem[],
  outcome?: TurnOutcome,
): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    error:
      status === "failed"
        ? {
            code: "server_error",
            message: outcome?.error ?? "agent turn failed",
          }
        : null,
    incomplete_details: null,
    usage: outcome ? responseUsage(outcome.usage) : null,
  };
}

class ResponseOutputBuilder {
  readonly output: ResponseOutputItem[] = [];
  private readonly calls = new Map<
    string,
    { item: FunctionCallItem; index: number }
  >();
  private message: { item: MessageItem; index: number } | null = null;

  constructor(
    private readonly emit?: (event: Record<string, unknown>) => void,
  ) {}

  addText(delta: string): void {
    const message = this.ensureMessage();
    const part = message.item.content[0];
    if (part) part.text += delta;
    this.emit?.({
      type: "response.output_text.delta",
      output_index: message.index,
      content_index: 0,
      item_id: message.item.id,
      delta,
    });
  }

  addToolEvent(event: ToolCallEvent): void {
    if (event.type === "tool_call_start") {
      this.ensureToolCall(event.tool_call_id, event.tool_name ?? "tool");
      return;
    }
    if (event.type === "tool_call_arguments_delta") {
      const call = this.ensureToolCall(event.tool_call_id, "tool");
      call.item.arguments += event.arguments_delta;
      this.emit?.({
        type: "response.function_call_arguments.delta",
        output_index: call.index,
        item_id: call.item.id,
        delta: event.arguments_delta,
      });
      return;
    }

    const call = this.ensureToolCall(
      event.tool_call_id,
      event.tool_name ?? "tool",
    );
    call.item.name = event.tool_name ?? call.item.name;
    call.item.arguments = event.arguments;
    call.item.status = event.success ? "completed" : "failed";
    this.emit?.({
      type: "response.function_call_arguments.done",
      output_index: call.index,
      item_id: call.item.id,
      name: call.item.name,
      arguments: call.item.arguments,
    });
    this.emit?.({
      type: "response.output_item.done",
      output_index: call.index,
      item: call.item,
    });

    const result: FunctionCallOutputItem = {
      type: "function_call_output",
      id: `fco_${randomUUID()}`,
      call_id: event.tool_call_id,
      output: [{ type: "input_text", text: event.output }],
      status: event.success ? "completed" : "failed",
    };
    const outputIndex = this.output.length;
    this.output.push(result);
    this.emit?.({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: result,
    });
    this.emit?.({
      type: "response.output_item.done",
      output_index: outputIndex,
      item: result,
    });
  }

  finishText(): void {
    if (!this.message) return;
    const { item, index } = this.message;
    item.status = "completed";
    const part = item.content[0];
    if (!part) return;
    this.emit?.({
      type: "response.output_text.done",
      output_index: index,
      content_index: 0,
      item_id: item.id,
      text: part.text,
    });
    this.emit?.({
      type: "response.content_part.done",
      output_index: index,
      content_index: 0,
      item_id: item.id,
      part,
    });
    this.emit?.({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  private ensureMessage(): { item: MessageItem; index: number } {
    if (this.message) return this.message;
    const item: MessageItem = {
      type: "message",
      id: `msg_${randomUUID()}`,
      status: "in_progress",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    };
    const index = this.output.length;
    this.output.push(item);
    this.message = { item, index };
    this.emit?.({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, content: [] },
    });
    this.emit?.({
      type: "response.content_part.added",
      output_index: index,
      content_index: 0,
      item_id: item.id,
      part: item.content[0],
    });
    return this.message;
  }

  private ensureToolCall(
    callId: string,
    name: string,
  ): { item: FunctionCallItem; index: number } {
    const existing = this.calls.get(callId);
    if (existing) {
      if (existing.item.name === "tool" && name !== "tool") {
        existing.item.name = name;
      }
      return existing;
    }
    const item: FunctionCallItem = {
      type: "function_call",
      id: `fc_${randomUUID()}`,
      call_id: callId,
      name,
      arguments: "",
      status: "in_progress",
    };
    const index = this.output.length;
    this.output.push(item);
    const state = { item, index };
    this.calls.set(callId, state);
    this.emit?.({
      type: "response.output_item.added",
      output_index: index,
      item,
    });
    return state;
  }
}

function writeSseEvent(
  response: ServerResponse,
  sequenceNumber: number,
  event: Record<string, unknown>,
): void {
  const payload = { sequence_number: sequenceNumber, ...event };
  response.write(`event: ${String(event.type)}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function handleResponses(
  request: HttpIncomingMessage,
  response: ServerResponse,
  options: OpenAiCompatOptions,
): Promise<void> {
  let body: ResponsesRequest;
  try {
    body = (await readJsonBody(request)) as ResponsesRequest;
  } catch (error) {
    sendOpenAiError(
      response,
      400,
      error instanceof Error ? error.message : "invalid JSON body",
      "invalid_request_error",
    );
    return;
  }
  if (!body.model) {
    sendOpenAiError(
      response,
      400,
      "you must provide a model parameter",
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

  const input = normalizeInput(body.input);
  const previous = body.previous_response_id
    ? storedResponseState.get(body.previous_response_id)
    : undefined;
  if (body.previous_response_id && !previous) {
    sendOpenAiError(
      response,
      404,
      `Previous response '${body.previous_response_id}' was not found.`,
      "invalid_request_error",
      "previous_response_not_found",
    );
    return;
  }
  if (previous && previous.agentId !== agent.id) {
    sendOpenAiError(
      response,
      400,
      "previous_response_id belongs to a different model",
      "invalid_request_error",
    );
    return;
  }

  const headerChatKey = chatKeyFromHeaders(request, body.stream === true);
  const stateful = Boolean(previous || headerChatKey);
  const prepared = toBridgeMessages(input, stateful);
  if (!prepared.correlationOtid) {
    sendOpenAiError(
      response,
      400,
      "input must include a user message with text or image content",
      "invalid_request_error",
    );
    return;
  }

  let conversationId: string;
  try {
    if (previous) {
      conversationId = previous.conversationId;
    } else if (headerChatKey) {
      const key = `chat-key:${agent.id}:${headerChatKey}`;
      conversationId = await resolveConversationId(agent.id, key);
      rememberConversation(key, conversationId);
    } else {
      conversationId = await createConversationSerialized(agent.id);
    }
  } catch (error) {
    options.onLog?.(
      `OpenAI-compat failed to create conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    sendOpenAiError(
      response,
      500,
      "failed to create a conversation for this response",
      "server_error",
    );
    return;
  }

  const responseId = `resp_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const streaming = body.stream === true;
  let sequenceNumber = 0;
  let clientClosed = false;
  response.on("close", () => {
    clientClosed = true;
  });
  const emit = streaming
    ? (event: Record<string, unknown>) => {
        if (clientClosed) return;
        writeSseEvent(response, sequenceNumber++, event);
      }
    : undefined;
  const builder = new ResponseOutputBuilder(emit);

  if (streaming) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    emit?.({
      type: "response.created",
      response: makeResponse(
        responseId,
        createdAt,
        body.model,
        "in_progress",
        [],
      ),
    });
    emit?.({
      type: "response.in_progress",
      response: makeResponse(
        responseId,
        createdAt,
        body.model,
        "in_progress",
        [],
      ),
    });
  }

  let outcome: TurnOutcome;
  try {
    outcome = await runBridgeTurn({
      agentId: agent.id,
      conversationId,
      messages: prepared.messages,
      correlationOtid: prepared.correlationOtid,
      onLog: options.onLog,
      onAssistantText: (delta) => builder.addText(delta),
      onToolEvent: (event) => builder.addToolEvent(event),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.(`OpenAI Responses turn failed: ${message}`);
    outcome = {
      text: "",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      error: "failed to run agent turn",
    };
  }

  // Idempotent/replayed test seams can return an outcome without invoking
  // callbacks. Reconstruct output from the completed outcome in that case.
  if (builder.output.length === 0) {
    for (const event of outcome.toolEvents ?? []) builder.addToolEvent(event);
    if (outcome.text) builder.addText(outcome.text);
  }
  builder.finishText();

  // OpenAI Responses are stored by default; `store: false` opts out.
  const shouldStore =
    body.store !== false || Boolean(headerChatKey || previous);
  if (shouldStore && !outcome.error) {
    rememberResponseState(responseId, { agentId: agent.id, conversationId });
  } else if (!headerChatKey && !previous) {
    void getBackend()
      .deleteConversation?.(conversationId)
      .catch(() => {
        options.onLog?.(
          `OpenAI-compat failed to delete ephemeral conversation ${conversationId}`,
        );
      });
  }

  if (clientClosed) return;
  if (outcome.error) {
    const failed = makeResponse(
      responseId,
      createdAt,
      body.model,
      "failed",
      builder.output,
      outcome,
    );
    if (streaming) {
      emit?.({ type: "response.failed", response: failed });
      response.end();
    } else {
      sendJson(response, 500, failed);
    }
    return;
  }

  const completed = makeResponse(
    responseId,
    createdAt,
    body.model,
    "completed",
    builder.output,
    outcome,
  );
  if (streaming) {
    emit?.({ type: "response.completed", response: completed });
    response.end();
  } else {
    sendJson(response, 200, completed);
  }
}
