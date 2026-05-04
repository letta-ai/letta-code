import {
  tool as aiTool,
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessageChunk,
  validateUIMessages,
} from "ai";
import type { ClientTool } from "../../tools/manager";
import type { LocalMessage } from "../local/LocalMessage";
import { createAISDKModelFactoryFromAgent } from "./AISDKModelFactory";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";
import { providerStreamPart, providerUIMessage } from "./ProviderTurnExecutor";

type AISDKProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];
type AISDKProviderKind = "anthropic" | "openai" | "unknown";
type AISDKUIMessageStreamFinish = {
  messages: LocalMessage[];
  responseMessage: LocalMessage;
  isContinuation: boolean;
  isAborted: boolean;
  finishReason?: unknown;
};

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
    originalMessages?: LocalMessage[];
    sendSources?: boolean;
    onFinish?: (
      options: AISDKUIMessageStreamFinish,
    ) => void | PromiseLike<void>;
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

function isAdaptiveAnthropicThinkingModel(modelHandle: string): boolean {
  return (
    modelHandle.includes("claude-sonnet-4-6") ||
    modelHandle.includes("claude-opus-4-6") ||
    modelHandle.includes("claude-opus-4-7")
  );
}

function shouldSummarizeAnthropicThinking(modelHandle: string): boolean {
  return modelHandle.includes("claude-opus-4-7");
}

function anthropicThinking(value: unknown, modelHandle: string) {
  const adaptiveDisplay = shouldSummarizeAnthropicThinking(modelHandle)
    ? { display: "summarized" as const }
    : {};

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
    if (isAdaptiveAnthropicThinkingModel(modelHandle)) {
      return { type: "adaptive", ...adaptiveDisplay };
    }
    const budgetTokens =
      numberValue(value.budgetTokens) ?? numberValue(value.budget_tokens);
    return {
      type,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    };
  }
  return undefined;
}

function aiSDKProviderKind(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): AISDKProviderKind {
  const providerType = stringValue(modelSettings.provider_type);
  if (
    providerType === "openai" ||
    providerType === "openai-responses" ||
    modelHandle.startsWith("openai/") ||
    modelHandle.startsWith("openai-codex/")
  ) {
    return "openai";
  }
  if (providerType === "anthropic" || modelHandle.startsWith("anthropic/")) {
    return "anthropic";
  }
  return "unknown";
}

function partProviderMetadata(
  part: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(part)) return undefined;
  const providerMetadata = part.providerMetadata ?? part.providerOptions;
  return isRecord(providerMetadata) ? providerMetadata : undefined;
}

function hasOpenAIReasoningMetadata(part: unknown): boolean {
  const metadata = partProviderMetadata(part);
  const openai = isRecord(metadata?.openai) ? metadata.openai : undefined;
  return (
    typeof openai?.itemId === "string" ||
    typeof openai?.reasoningEncryptedContent === "string"
  );
}

function hasAnthropicReasoningMetadata(part: unknown): boolean {
  const metadata = partProviderMetadata(part);
  const anthropic = isRecord(metadata?.anthropic)
    ? metadata.anthropic
    : undefined;
  return (
    typeof anthropic?.signature === "string" ||
    typeof anthropic?.redactedData === "string"
  );
}

function shouldKeepReasoningPart(
  part: unknown,
  provider: AISDKProviderKind,
): boolean {
  if (!isRecord(part) || part.type !== "reasoning") return true;
  if (provider === "openai") return hasOpenAIReasoningMetadata(part);
  if (provider === "anthropic") return hasAnthropicReasoningMetadata(part);
  return true;
}

function sanitizeUIMessagesForProvider(
  messages: LocalMessage[],
  provider: AISDKProviderKind,
): LocalMessage[] {
  if (provider === "unknown") return messages;
  return messages
    .map((message) => {
      const parts = message.parts.filter((part) =>
        shouldKeepReasoningPart(part, provider),
      );
      return parts.length === message.parts.length
        ? message
        : { ...message, parts };
    })
    .filter(
      (message) => message.role !== "assistant" || message.parts.length > 0,
    );
}

export function buildAISDKProviderOptions(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): AISDKProviderOptions | undefined {
  const provider = aiSDKProviderKind(modelHandle, modelSettings);

  if (provider === "openai") {
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

  if (provider === "anthropic") {
    const effort = anthropicEffort(
      modelSettings.effort ?? modelSettings.reasoning_effort,
    );
    const thinking =
      anthropicThinking(modelSettings.thinking, modelHandle) ??
      (effort !== undefined && isAdaptiveAnthropicThinkingModel(modelHandle)
        ? {
            type: "adaptive" as const,
            ...(shouldSummarizeAnthropicThinking(modelHandle)
              ? { display: "summarized" as const }
              : {}),
          }
        : undefined);
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
  originalMessages: LocalMessage[],
): Promise<LocalMessage | undefined> {
  if (!result.toUIMessageStream) return undefined;

  let finalMessage: LocalMessage | undefined;
  const stream = result.toUIMessageStream({
    originalMessages,
    sendSources: true,
    onFinish: ({ responseMessage }) => {
      finalMessage = responseMessage;
    },
  });

  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
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
    const provider = aiSDKProviderKind(
      input.agent.model,
      input.agent.model_settings,
    );
    const uiMessages = await validateUIMessages<LocalMessage>({
      messages: sanitizeUIMessagesForProvider(input.uiMessages, provider),
      tools: tools as never,
    });
    const result = this.runStreamText({
      model:
        this.createModel?.() ??
        createAISDKModelFactoryFromAgent(
          input.agent.model,
          input.agent.model_settings,
        )(),
      system: input.systemPrompt ?? input.agent.system,
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
