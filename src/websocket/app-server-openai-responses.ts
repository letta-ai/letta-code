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

interface StoredResponseState {
  agentId: string;
  conversationId: string;
}

const STORED_RESPONSE_PREFIX = "resp_letta_";

function createStoredResponseId(state: StoredResponseState): string {
  const cursor = Buffer.from(
    JSON.stringify({
      version: 1,
      nonce: randomUUID(),
      agent_id: state.agentId,
      conversation_id: state.conversationId,
    }),
  ).toString("base64url");
  return `${STORED_RESPONSE_PREFIX}${cursor}`;
}

function parseStoredResponseId(responseId: string): StoredResponseState | null {
  if (!responseId.startsWith(STORED_RESPONSE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(
        responseId.slice(STORED_RESPONSE_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.version !== 1 ||
      typeof parsed.agent_id !== "string" ||
      typeof parsed.conversation_id !== "string"
    ) {
      return null;
    }
    return {
      agentId: parsed.agent_id,
      conversationId: parsed.conversation_id,
    };
  } catch {
    return null;
  }
}

interface FunctionCallItem {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
  status: "in_progress" | "completed" | "incomplete";
}

interface FunctionCallOutputItem {
  type: "function_call_output";
  id: string;
  call_id: string;
  output: Array<{ type: "input_text"; text: string }>;
  status: "completed" | "incomplete";
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

interface ReasoningItem {
  type: "reasoning";
  id: string;
  status: "in_progress" | "completed";
  summary: Array<{ type: "summary_text"; text: string }>;
}

type ResponseOutputItem =
  | FunctionCallItem
  | FunctionCallOutputItem
  | ReasoningItem
  | MessageItem;

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

function inputInstructions(input: ResponsesRequest["input"]): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (item) =>
        item?.type === "message" &&
        (item.role === "system" || item.role === "developer"),
    )
    .map((item) => extractTextContent(item.content))
    .filter(Boolean);
}

function applyInstructions(
  messages: BridgeTurnMessage[],
  instructions: Array<string | null | undefined>,
): void {
  const text = instructions
    .map((instruction) => instruction?.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!text) return;
  const userMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (!userMessage) return;
  userMessage.content.unshift({
    type: "text",
    text: `<system-reminder>\n${text}\n</system-reminder>\n\n`,
  });
}

function responseUsage(usage: TurnOutcome["usage"]): Record<string, unknown> {
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    output_tokens_details: {
      reasoning_tokens: usage.reasoning_tokens ?? 0,
    },
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
  private reasoning: { item: ReasoningItem; index: number } | null = null;

  constructor(
    private readonly emit?: (event: Record<string, unknown>) => void,
  ) {}

  addText(delta: string): void {
    this.finishReasoning();
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

  addReasoning(delta: string): void {
    this.finishText();
    const reasoning = this.ensureReasoning();
    const part = reasoning.item.summary[0];
    if (part) part.text += delta;
    this.emit?.({
      type: "response.reasoning_summary_text.delta",
      output_index: reasoning.index,
      summary_index: 0,
      item_id: reasoning.item.id,
      delta,
    });
  }

  addToolEvent(event: ToolCallEvent): void {
    this.finishReasoning();
    if (event.type === "tool_call_start") {
      this.finishText();
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
    call.item.status = event.success ? "completed" : "incomplete";
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

    this.finishText();
    const result: FunctionCallOutputItem = {
      type: "function_call_output",
      id: `fco_${randomUUID()}`,
      call_id: event.tool_call_id,
      output: [{ type: "input_text", text: event.output }],
      status: event.success ? "completed" : "incomplete",
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
    this.message = null;
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

  finishReasoning(): void {
    if (!this.reasoning) return;
    const { item, index } = this.reasoning;
    this.reasoning = null;
    item.status = "completed";
    const part = item.summary[0];
    if (!part) return;
    this.emit?.({
      type: "response.reasoning_summary_text.done",
      output_index: index,
      summary_index: 0,
      item_id: item.id,
      text: part.text,
    });
    this.emit?.({
      type: "response.reasoning_summary_part.done",
      output_index: index,
      summary_index: 0,
      item_id: item.id,
      part,
    });
    this.emit?.({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }

  finish(): void {
    this.finishReasoning();
    this.finishText();
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

  private ensureReasoning(): { item: ReasoningItem; index: number } {
    if (this.reasoning) return this.reasoning;
    const item: ReasoningItem = {
      type: "reasoning",
      id: `rs_${randomUUID()}`,
      status: "in_progress",
      summary: [{ type: "summary_text", text: "" }],
    };
    const index = this.output.length;
    this.output.push(item);
    this.reasoning = { item, index };
    this.emit?.({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, summary: [] },
    });
    this.emit?.({
      type: "response.reasoning_summary_part.added",
      output_index: index,
      summary_index: 0,
      item_id: item.id,
      part: item.summary[0],
    });
    return this.reasoning;
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
  const streaming = body.stream === true;
  const headerChatKey = chatKeyFromHeaders(request, streaming);
  const previousResponse = body.previous_response_id
    ? parseStoredResponseId(body.previous_response_id)
    : null;
  if (body.previous_response_id && !previousResponse) {
    sendOpenAiError(
      response,
      404,
      `The response '${body.previous_response_id}' does not exist or is no longer stored.`,
      "invalid_request_error",
      "response_not_found",
    );
    return;
  }
  if (previousResponse && previousResponse.agentId !== agent.id) {
    sendOpenAiError(
      response,
      404,
      `The response '${body.previous_response_id}' does not exist for model '${body.model}'.`,
      "invalid_request_error",
      "response_not_found",
    );
    return;
  }
  if (previousResponse) {
    try {
      const source = await getBackend().retrieveConversation(
        previousResponse.conversationId,
      );
      if (source.agent_id !== agent.id) {
        sendOpenAiError(
          response,
          404,
          `The response '${body.previous_response_id}' does not exist for model '${body.model}'.`,
          "invalid_request_error",
          "response_not_found",
        );
        return;
      }
    } catch {
      sendOpenAiError(
        response,
        404,
        `The response '${body.previous_response_id}' does not exist or is no longer stored.`,
        "invalid_request_error",
        "response_not_found",
      );
      return;
    }
  }

  const prepared = toBridgeMessages(
    input,
    Boolean(headerChatKey || previousResponse),
  );
  applyInstructions(prepared.messages, [
    body.instructions,
    ...inputInstructions(body.input),
  ]);
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
    if (previousResponse) {
      const backend = getBackend();
      if (!backend.forkConversation) {
        sendOpenAiError(
          response,
          501,
          "previous_response_id is unavailable because this backend cannot fork conversations",
          "server_error",
          "unsupported_backend",
        );
        return;
      }
      const forked = await backend.forkConversation(
        previousResponse.conversationId,
        {
          agentId: agent.id,
          hidden: true,
        },
      );
      conversationId = forked.id;
      if (headerChatKey) {
        const key = `chat-key:${agent.id}:${headerChatKey}`;
        rememberConversation(key, conversationId);
      }
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

  const responseId =
    body.store === true
      ? createStoredResponseId({ agentId: agent.id, conversationId })
      : `resp_${randomUUID()}`;
  const createdAt = Math.floor(Date.now() / 1000);
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
      onReasoningText: (delta) => builder.addReasoning(delta),
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

  // Test seams may return a completed outcome without invoking callbacks.
  if (builder.output.length === 0) {
    if (outcome.reasoning) builder.addReasoning(outcome.reasoning);
    if (outcome.text) builder.addText(outcome.text);
  }
  builder.finish();

  const shouldStore = body.store === true && !outcome.error;
  // Stateless requests replay the supplied input into a fresh conversation.
  // Stored Responses and header-keyed chats retain their conversation state.
  if (!headerChatKey && !shouldStore) {
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
