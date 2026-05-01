import { createOpenAI } from "@ai-sdk/openai";
import {
  tool as aiTool,
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  readUIMessageStream,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessageChunk,
  validateUIMessages,
} from "ai";
import type { ClientTool } from "../../tools/manager";
import type { ProviderTrajectoryUIMessage } from "./ProviderTrajectory";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";
import { providerStreamPart, providerUIMessage } from "./ProviderTurnExecutor";

const DEFAULT_OPENAI_RESPONSES_MODEL = "gpt-5.5";

type StreamTextFunction = (options: {
  model: LanguageModel;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxRetries: number;
  abortSignal?: AbortSignal;
}) => {
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  toUIMessageStream?: (options?: {
    originalMessages?: ProviderTrajectoryUIMessage[];
    sendSources?: boolean;
  }) => ReadableStream<UIMessageChunk>;
};

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

async function captureFinalUIMessage(
  result: ReturnType<StreamTextFunction>,
  originalMessages: ProviderTrajectoryUIMessage[],
): Promise<ProviderTrajectoryUIMessage | undefined> {
  if (!result.toUIMessageStream) return undefined;

  let finalMessage: ProviderTrajectoryUIMessage | undefined;
  for await (const message of readUIMessageStream<ProviderTrajectoryUIMessage>({
    stream: result.toUIMessageStream({
      originalMessages,
      sendSources: true,
    }),
  })) {
    finalMessage = message;
  }
  return finalMessage;
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
    const uiMessages = await validateUIMessages<ProviderTrajectoryUIMessage>({
      messages: input.uiMessages,
      tools: tools as never,
    });
    const result = this.runStreamText({
      model: this.createModel(this.model),
      messages: await convertToModelMessages(uiMessages, { tools }),
      tools,
      maxRetries: 0,
      abortSignal: this.abortSignal,
    });
    let uiMessageError: unknown;
    const finalUIMessage = captureFinalUIMessage(result, uiMessages).catch(
      (error) => {
        uiMessageError = error;
        return undefined;
      },
    );

    for await (const part of result.fullStream) {
      yield providerStreamPart(part);
    }

    const message = await finalUIMessage;
    if (uiMessageError) throw uiMessageError;
    if (message) {
      yield providerUIMessage(message);
    }
  }
}
