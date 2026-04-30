import { createOpenAI } from "@ai-sdk/openai";
import {
  tool as aiTool,
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { ClientTool } from "../../tools/manager";
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
    const tools = toToolSet(input.clientTools);
    const result = this.runStreamText({
      model: this.createModel(this.model),
      messages: await convertToModelMessages(input.uiMessages, { tools }),
      tools,
      maxRetries: 0,
      abortSignal: this.abortSignal,
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        yield { type: "text-delta", text: part.text };
        continue;
      }

      if (part.type === "reasoning-delta") {
        yield { type: "reasoning-delta", text: part.text };
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
