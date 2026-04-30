import { createOpenAI } from "@ai-sdk/openai";
import {
  tool as aiTool,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { ClientTool } from "../../tools/manager";
import type { StoredMessage } from "./FakeHeadlessStore";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";

const DEFAULT_OPENAI_RESPONSES_MODEL = "gpt-5.5";

type StreamTextFunction = (options: {
  model: LanguageModel;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxRetries: number;
  abortSignal?: AbortSignal;
}) => { fullStream: AsyncIterable<TextStreamPart<ToolSet>> };

export interface OpenAIResponsesStreamAdapterOptions {
  model?: string;
  apiKey?: string;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  createModel?: (model: string) => LanguageModel;
  streamText?: StreamTextFunction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function toolCallFromMessage(message: StoredMessage):
  | {
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | undefined {
  const toolCall = (message as unknown as { tool_call?: unknown }).tool_call;
  if (!isRecord(toolCall)) return undefined;
  const toolCallId = toolCall.tool_call_id;
  const toolName = toolCall.name;
  if (typeof toolCallId !== "string" || typeof toolName !== "string") {
    return undefined;
  }
  return {
    toolCallId,
    toolName,
    input: parseToolInput(toolCall.arguments),
  };
}

type ApprovalToolResult = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output:
    | { type: "text"; value: string }
    | { type: "execution-denied"; reason?: string };
};

function approvalResultsFromMessage(
  message: StoredMessage,
): ApprovalToolResult[] {
  const approvals = Array.isArray(
    (message as unknown as { approvals?: unknown }).approvals,
  )
    ? (message as unknown as { approvals: unknown[] }).approvals
    : Array.isArray(message.content)
      ? message.content
      : [];
  const results: ApprovalToolResult[] = [];
  for (const approval of approvals) {
    if (!isRecord(approval)) continue;
    const toolCallId = approval.tool_call_id;
    if (typeof toolCallId !== "string") continue;

    if (approval.type === "approval" && approval.approve === false) {
      results.push({
        type: "tool-result",
        toolCallId,
        toolName: "unknown",
        output: {
          type: "execution-denied",
          reason:
            typeof approval.reason === "string" ? approval.reason : undefined,
        },
      });
      continue;
    }

    if (approval.type !== "tool") continue;
    const toolReturn = textFromContent(approval.tool_return);
    results.push({
      type: "tool-result",
      toolCallId,
      toolName: "unknown",
      output: { type: "text", value: toolReturn },
    });
  }
  return results;
}

function appendAssistantText(messages: ModelMessage[], text: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && typeof last.content === "string") {
    last.content += text;
    return;
  }

  messages.push({ role: "assistant", content: text });
}

function appendAssistantToolCall(
  messages: ModelMessage[],
  toolCall: { toolCallId: string; toolName: string; input: unknown },
): void {
  const toolCallPart = { type: "tool-call" as const, ...toolCall };
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") {
    if (typeof last.content === "string") {
      last.content = [
        { type: "text" as const, text: last.content },
        toolCallPart,
      ];
      return;
    }

    if (Array.isArray(last.content)) {
      last.content = [...last.content, toolCallPart];
      return;
    }
  }

  messages.push({
    role: "assistant",
    content: [toolCallPart],
  });
}

export function storedMessagesToModelMessages(
  history: StoredMessage[],
): ModelMessage[] {
  const toolNamesByCallId = new Map<string, string>();
  const messages: ModelMessage[] = [];

  for (const message of history) {
    if (message.message_type === "user_message") {
      const text = textFromContent(message.content);
      if (text.length > 0) {
        messages.push({ role: "user", content: text });
      }
      continue;
    }

    if (message.message_type === "assistant_message") {
      const text = textFromContent(message.content);
      if (text.length > 0) {
        appendAssistantText(messages, text);
      }
      continue;
    }

    if (message.message_type === "approval_request_message") {
      const toolCall = toolCallFromMessage(message);
      if (!toolCall) continue;
      toolNamesByCallId.set(toolCall.toolCallId, toolCall.toolName);
      appendAssistantToolCall(messages, toolCall);
      continue;
    }

    if (message.message_type === "approval_response_message") {
      const results = approvalResultsFromMessage(message).map((result) => ({
        ...result,
        toolName: toolNamesByCallId.get(result.toolCallId) ?? result.toolName,
      }));
      if (results.length > 0) {
        messages.push({ role: "tool", content: results });
      }
    }
  }

  return messages;
}

function isClientTool(value: unknown): value is ClientTool {
  return isRecord(value) && typeof value.name === "string";
}

function toToolSet(clientTools: unknown[]): ToolSet | undefined {
  const tools: ToolSet = {};
  for (const value of clientTools) {
    if (!isClientTool(value)) continue;
    const schema = isRecord(value.parameters)
      ? value.parameters
      : { type: "object", additionalProperties: true };
    tools[value.name] = aiTool({
      description: value.description ?? undefined,
      inputSchema: jsonSchema(schema),
    });
  }
  return Object.keys(tools).length > 0 ? tools : undefined;
}

function createDefaultOpenAIResponsesModel(options: {
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): LanguageModel {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    fetch: options.fetch,
  });
  return provider.responses(options.model);
}

function defaultStreamText(options: Parameters<StreamTextFunction>[0]) {
  return streamText(options);
}

export class OpenAIResponsesStreamAdapter implements ProviderStreamAdapter {
  private readonly model: string;
  private readonly createModel: (model: string) => LanguageModel;
  private readonly runStreamText: StreamTextFunction;
  private readonly abortSignal?: AbortSignal;

  constructor(options: OpenAIResponsesStreamAdapterOptions = {}) {
    this.model =
      options.model ??
      process.env.LETTA_CODE_DEV_OPENAI_MODEL ??
      DEFAULT_OPENAI_RESPONSES_MODEL;
    this.createModel =
      options.createModel ??
      ((model) =>
        createDefaultOpenAIResponsesModel({
          model,
          apiKey: options.apiKey,
          fetch: options.fetch,
        }));
    this.runStreamText = options.streamText ?? defaultStreamText;
    this.abortSignal = options.abortSignal;
  }

  async *stream(input: ProviderTurnInput): AsyncIterable<ProviderStreamEvent> {
    const result = this.runStreamText({
      model: this.createModel(this.model),
      messages: storedMessagesToModelMessages(input.history),
      tools: toToolSet(input.clientTools),
      maxRetries: 0,
      abortSignal: this.abortSignal,
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "text-delta", text: part.text };
        continue;
      }

      if (part.type === "tool-call") {
        yield {
          type: "tool-call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
        continue;
      }

      if (part.type === "finish") {
        yield { type: "finish", finishReason: part.finishReason };
        continue;
      }

      if (part.type === "error") {
        yield { type: "error", error: part.error };
      }
    }
  }
}
