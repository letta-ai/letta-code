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

type AISDKProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

export type AISDKStreamTextFunction = (options: {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  providerOptions?: AISDKProviderOptions;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function openAIReasoningEffort(value: unknown) {
  const effort = stringValue(value);
  return effort === "none" ||
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
    ? effort
    : undefined;
}

function openAITextVerbosity(value: unknown) {
  const verbosity = stringValue(value);
  return verbosity === "low" || verbosity === "medium" || verbosity === "high"
    ? verbosity
    : undefined;
}

function anthropicEffort(value: unknown) {
  const effort = stringValue(value);
  if (effort === "none") return undefined;
  return effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
    ? effort
    : undefined;
}

function anthropicThinking(value: unknown) {
  if (!isRecord(value)) return undefined;
  const type = stringValue(value.type);
  if (type === "disabled") {
    return { type };
  }
  if (type === "adaptive") {
    const display = stringValue(value.display);
    return {
      type,
      ...(display === "omitted" || display === "summarized" ? { display } : {}),
    };
  }
  if (type === "enabled") {
    const budgetTokens =
      numberValue(value.budgetTokens) ?? numberValue(value.budget_tokens);
    return {
      type,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
  }
  return undefined;
}

export function buildAISDKProviderOptions(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): AISDKProviderOptions | undefined {
  const providerType = stringValue(modelSettings.provider_type);
  const isOpenAI =
    providerType === "openai" ||
    modelHandle.startsWith("openai/") ||
    modelHandle.startsWith("openai-codex/");
  const isAnthropic =
    providerType === "anthropic" || modelHandle.startsWith("anthropic/");

  if (isOpenAI) {
    const reasoning = isRecord(modelSettings.reasoning)
      ? modelSettings.reasoning
      : undefined;
    const reasoningEffort = openAIReasoningEffort(
      reasoning?.reasoning_effort ?? modelSettings.reasoning_effort,
    );
    const textVerbosity = openAITextVerbosity(modelSettings.verbosity);
    const parallelToolCalls = boolValue(modelSettings.parallel_tool_calls);
    const openai = {
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      ...(textVerbosity !== undefined ? { textVerbosity } : {}),
      ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
    };
    return Object.keys(openai).length > 0 ? { openai } : undefined;
  }

  if (isAnthropic) {
    const thinking = anthropicThinking(modelSettings.thinking);
    const effort = anthropicEffort(
      modelSettings.effort ?? modelSettings.reasoning_effort,
    );
    const anthropic = {
      ...(thinking !== undefined ? { thinking } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
    return Object.keys(anthropic).length > 0 ? { anthropic } : undefined;
  }

  return undefined;
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
      providerOptions: buildAISDKProviderOptions(
        input.agent.model,
        input.agent.model_settings,
      ),
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
