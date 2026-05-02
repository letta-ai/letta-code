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
import type { ProviderTrajectoryUIMessage } from "../local/ProviderTrajectory";
import { createAISDKModelFactoryFromAgent } from "./AISDKModelFactory";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";
import { providerStreamPart, providerUIMessage } from "./ProviderTurnExecutor";

export type AISDKStreamTextFunction = (options: {
  model: LanguageModel;
  system?: string;
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

export interface AISDKStreamAdapterOptions {
  createModel?: () => LanguageModel;
  abortSignal?: AbortSignal;
  streamText?: AISDKStreamTextFunction;
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

function defaultStreamText(options: Parameters<AISDKStreamTextFunction>[0]) {
  return streamText(options);
}

async function captureFinalUIMessage(
  result: ReturnType<AISDKStreamTextFunction>,
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

export class AISDKStreamAdapter implements ProviderStreamAdapter {
  private readonly createModel?: () => LanguageModel;
  private readonly runStreamText: AISDKStreamTextFunction;
  private readonly abortSignal?: AbortSignal;

  constructor(options: AISDKStreamAdapterOptions) {
    this.createModel = options.createModel;
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
      model:
        this.createModel?.() ??
        createAISDKModelFactoryFromAgent(
          input.agent.model,
          input.agent.model_settings,
        )(),
      system: input.agent.system,
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
