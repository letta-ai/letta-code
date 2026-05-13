import {
  tool as aiTool,
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  streamText,
  type TextStreamPart,
  type ToolSet,
  type UIMessageChunk,
  validateUIMessages,
} from "ai";
import type { ClientTool } from "../../tools/manager";
import type { LocalCompactionStats } from "../local/compaction";
import type { LocalMessage } from "../local/LocalMessage";
import { createAISDKModelFactoryFromAgent } from "./AISDKModelFactory";
import {
  type AISDKProviderKind,
  aiSDKProviderKindFromModel,
} from "./AISDKProviderRegistry";
import { isContextWindowOverflowError } from "./contextWindowOverflow";
import {
  isRetryableLocalProviderError,
  localProviderRetryDelayMs,
  localProviderRetryMessage,
} from "./LocalProviderErrors";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";
import {
  providerLettaChunk,
  providerStreamPart,
  providerUIMessage,
} from "./ProviderTurnExecutor";

type AISDKProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];
type InputModality = "text" | "image" | "audio" | "video" | "pdf";
const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3;
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
  onError?: (event: { error: unknown }) => void;
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
  localProviderAuthStorageDir?: string;
  onContextWindowOverflow?: (
    input: ProviderTurnInput,
    error: unknown,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>;
  onContextUsage?: (
    input: ProviderTurnInput,
    usage: LanguageModelUsage,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelOutputEvent(event: ProviderStreamEvent): boolean {
  if (event.type === "ai-sdk-ui-message") return true;
  if (event.type !== "ai-sdk-part") return false;
  switch (event.part.type) {
    case "text-delta":
    case "reasoning-delta":
    case "tool-call":
      return true;
    default:
      return false;
  }
}

async function sleepWithAbort(
  delayMs: number,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0) return;
  if (abortSignal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
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
  return aiSDKProviderKindFromModel(modelHandle, modelSettings);
}

function isChatGPTOAuthModel(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): boolean {
  return (
    modelHandle.startsWith("chatgpt-plus-pro/") ||
    stringValue(modelSettings.provider_type) === "chatgpt_oauth"
  );
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

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function mimeToModality(mime: string): InputModality | undefined {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  return undefined;
}

function modalitiesFromModelSettings(
  modelSettings: Record<string, unknown>,
): Set<InputModality> | undefined {
  const modalities = isRecord(modelSettings.modalities)
    ? modelSettings.modalities
    : undefined;
  const input = stringArray(modalities?.input);
  if (!input) return undefined;

  return new Set(
    input.filter((entry): entry is InputModality =>
      ["text", "image", "audio", "video", "pdf"].includes(entry),
    ),
  );
}

function capabilitiesFromModelSettings(
  modelSettings: Record<string, unknown>,
): Set<InputModality> | undefined {
  const capabilities = isRecord(modelSettings.capabilities)
    ? modelSettings.capabilities
    : undefined;
  const input = isRecord(capabilities?.input) ? capabilities.input : undefined;
  if (!input) return undefined;

  const supported = new Set<InputModality>(["text"]);
  for (const modality of ["image", "audio", "video", "pdf"] as const) {
    if (input[modality] === true) supported.add(modality);
  }
  return supported;
}

function knownModelInputModalities(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
): Set<InputModality> {
  const explicitModalities = modalitiesFromModelSettings(modelSettings);
  if (explicitModalities) return explicitModalities;

  const explicitCapabilities = capabilitiesFromModelSettings(modelSettings);
  if (explicitCapabilities) return explicitCapabilities;

  const handle = modelHandle.toLowerCase();
  const supported = new Set<InputModality>(["text"]);

  // Built-in local defaults. Custom/OpenAI-compatible models can opt in via
  // model_settings.modalities.input, matching OpenCode's configuration shape.
  if (
    handle.startsWith("anthropic/") ||
    handle.startsWith("claude-pro-max/") ||
    handle.startsWith("bedrock/") ||
    handle.startsWith("google_ai/") ||
    handle.startsWith("google_vertex/") ||
    handle.includes("gemini") ||
    handle.includes("claude") ||
    handle.includes("gpt-4o") ||
    handle.includes("gpt-4.1") ||
    handle.includes("gpt-5") ||
    handle.includes("o3") ||
    handle.includes("o4") ||
    handle.includes("vision") ||
    handle.includes("qwen-vl") ||
    handle.includes("qwen2-vl") ||
    handle.includes("qwen2.5-vl") ||
    handle.includes("qwen3-vl") ||
    handle.includes("llava") ||
    handle.includes("bakllava") ||
    handle.includes("moondream")
  ) {
    supported.add("image");
  }

  return supported;
}

function modelSupportsInputModality(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
  modality: InputModality,
): boolean {
  if (modality === "text") return true;
  return knownModelInputModalities(modelHandle, modelSettings).has(modality);
}

function isEmptyBase64DataUrl(data: unknown): boolean {
  if (typeof data !== "string" || !data.startsWith("data:")) return false;
  const match = data.match(/^data:([^;]+);base64,(.*)$/);
  return Boolean(match && (!match[2] || match[2].length === 0));
}

function filePartMediaType(part: Record<string, unknown>): string | undefined {
  if (typeof part.mediaType === "string") return part.mediaType;
  if (typeof part.mime === "string") return part.mime;
  return undefined;
}

function imagePartMediaType(part: Record<string, unknown>): string | undefined {
  if (typeof part.image === "string" && part.image.startsWith("data:")) {
    return part.image.split(";")[0]?.replace("data:", "");
  }
  if (isRecord(part.source) && typeof part.source.media_type === "string") {
    return part.source.media_type;
  }
  return undefined;
}

function partFilename(part: Record<string, unknown>): string | undefined {
  return stringValue(part.filename) ?? stringValue(part.name);
}

function replaceUnsupportedInputPart(
  part: LocalMessage["parts"][number],
  agent: ProviderTurnInput["agent"],
): LocalMessage["parts"][number] {
  if (!isRecord(part)) return part;
  const record = part as Record<string, unknown>;
  const partType = typeof record.type === "string" ? record.type : undefined;
  if (partType !== "file" && partType !== "image") {
    return part;
  }

  if (partType === "image" && isEmptyBase64DataUrl(record.image)) {
    return {
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    } as LocalMessage["parts"][number];
  }

  const mime =
    partType === "image"
      ? imagePartMediaType(record)
      : filePartMediaType(record);
  if (!mime) return part;

  const modality = mimeToModality(mime);
  if (!modality) return part;

  if (modelSupportsInputModality(agent.model, agent.model_settings, modality)) {
    return part;
  }

  const name = partFilename(record);
  return {
    type: "text",
    text: `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${modality} input). Inform the user.`,
  } as LocalMessage["parts"][number];
}

function replaceUnsupportedInputParts(
  messages: LocalMessage[],
  agent: ProviderTurnInput["agent"],
): LocalMessage[] {
  let didChange = false;
  const transformed = messages.map((message) => {
    if (message.role !== "user") return message;
    let messageDidChange = false;
    const parts = message.parts.map((part) => {
      const replacement = replaceUnsupportedInputPart(part, agent);
      if (replacement !== part) {
        didChange = true;
        messageDidChange = true;
      }
      return replacement;
    });
    return messageDidChange ? { ...message, parts } : message;
  });
  return didChange ? transformed : messages;
}

function isToolUIPart(part: unknown): part is Record<string, unknown> {
  return (
    isRecord(part) &&
    typeof part.type === "string" &&
    part.type.startsWith("tool-")
  );
}

/**
 * When the user interrupts a multi-step turn mid-stream, the last assistant
 * message can end up with a text part immediately following a tool part in the
 * same step (i.e., between two `step-start` markers). The AI SDK's
 * `convertToModelMessages` will then produce an assistant content block that
 * contains both a `tool_use` block and a `text` block, which Anthropic rejects
 * because text may not follow `tool_use` when a `tool_result` is expected next.
 *
 * This function inserts a `step-start` marker before any such trailing text
 * part, splitting the text into its own step so that `convertToModelMessages`
 * places it in a separate assistant message block.
 */
function separateTrailingTextAfterToolCalls(
  messages: LocalMessage[],
): LocalMessage[] {
  let didChange = false;
  const transformed = messages.map((message) => {
    if (message.role !== "assistant") return message;

    let messageChanged = false;
    const newParts: LocalMessage["parts"] = [];
    let stepHasToolCall = false;

    for (const part of message.parts) {
      if (!part) continue;

      if (part.type === "step-start") {
        stepHasToolCall = false;
        newParts.push(part);
        continue;
      }

      if (isToolUIPart(part)) {
        stepHasToolCall = true;
        newParts.push(part);
        continue;
      }

      if (stepHasToolCall && (part as { type?: unknown }).type === "text") {
        // Insert a step-start to separate the trailing text from the tool call,
        // preventing a mixed tool_use+text block in the converted model message.
        newParts.push({ type: "step-start" } as LocalMessage["parts"][number]);
        stepHasToolCall = false;
        messageChanged = true;
        didChange = true;
      }

      newParts.push(part);
    }

    return messageChanged ? { ...message, parts: newParts } : message;
  });

  return didChange ? transformed : messages;
}

function normalizeToolPartForModelConversion(part: Record<string, unknown>): {
  part: LocalMessage["parts"][number];
  changed: boolean;
} {
  const hasInput = Object.hasOwn(part, "input");
  if (part.state === "output-available" && Object.hasOwn(part, "output")) {
    if (hasInput) {
      return { part: part as LocalMessage["parts"][number], changed: false };
    }
    return {
      part: { ...part, input: {} } as LocalMessage["parts"][number],
      changed: true,
    };
  }

  const errorText =
    stringValue(part.errorText) ??
    (part.state === "output-available"
      ? "Tool output missing from previous turn."
      : "Tool result missing from interrupted previous turn.");
  const normalized = {
    ...part,
    state: "output-error",
    input: hasInput ? part.input : {},
    errorText,
  } as Record<string, unknown>;
  delete normalized.approval;
  delete normalized.output;
  return { part: normalized as LocalMessage["parts"][number], changed: true };
}

function normalizeToolPartsForModelConversion(
  messages: LocalMessage[],
): LocalMessage[] {
  let didChange = false;
  const transformed = messages.map((message) => {
    if (message.role !== "assistant") return message;

    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      const partRecord = part as Record<string, unknown>;
      const normalized = normalizeToolPartForModelConversion(partRecord);
      if (normalized.changed) {
        messageChanged = true;
        didChange = true;
      }
      return normalized.part;
    });

    return messageChanged ? { ...message, parts } : message;
  });
  return didChange ? transformed : messages;
}

function sanitizeUIMessagesForProvider(
  messages: LocalMessage[],
  provider: AISDKProviderKind,
  agent: ProviderTurnInput["agent"],
): LocalMessage[] {
  const settledMessages = normalizeToolPartsForModelConversion(
    separateTrailingTextAfterToolCalls(
      replaceUnsupportedInputParts(messages, agent),
    ),
  );
  if (provider === "unknown") return settledMessages;
  return settledMessages
    .map((message) => {
      let messageChanged = false;
      const filteredParts = message.parts.filter((part) =>
        shouldKeepReasoningPart(part, provider),
      );
      if (filteredParts.length !== message.parts.length) {
        messageChanged = true;
      }
      return messageChanged ? { ...message, parts: filteredParts } : message;
    })
    .filter(
      (message) => message.role !== "assistant" || message.parts.length > 0,
    );
}

export function buildAISDKProviderOptions(
  modelHandle: string,
  modelSettings: Record<string, unknown>,
  options: { systemPrompt?: string } = {},
): AISDKProviderOptions | undefined {
  const provider = aiSDKProviderKind(modelHandle, modelSettings);

  if (provider === "openai") {
    const chatgptOAuth = isChatGPTOAuthModel(modelHandle, modelSettings);
    const reasoning = isRecord(modelSettings.reasoning)
      ? modelSettings.reasoning
      : undefined;
    const reasoningEffort = openAIReasoningEffort(
      reasoning?.reasoning_effort ?? modelSettings.reasoning_effort,
    );
    const textVerbosity = openAITextVerbosity(modelSettings.verbosity);
    const parallelToolCalls = boolValue(modelSettings.parallel_tool_calls);
    const openai = {
      ...(chatgptOAuth
        ? {
            instructions: options.systemPrompt,
            store: false,
            systemMessageMode: "remove" as const,
          }
        : {}),
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
  private readonly localProviderAuthStorageDir?: string;
  private readonly onContextWindowOverflow?: AISDKStreamAdapterOptions["onContextWindowOverflow"];
  private readonly onContextUsage?: AISDKStreamAdapterOptions["onContextUsage"];

  constructor(options: AISDKStreamAdapterOptions) {
    this.createModel = options.createModel;
    this.runStreamText = options.streamText ?? defaultStreamText;
    this.abortSignal = options.abortSignal;
    this.localProviderAuthStorageDir = options.localProviderAuthStorageDir;
    this.onContextWindowOverflow = options.onContextWindowOverflow;
    this.onContextUsage = options.onContextUsage;
  }

  private async *emitCompactionChunks(
    compaction: {
      summary: string;
      stats?: LocalCompactionStats;
    },
    fallbackTrigger: string,
  ): AsyncIterable<ProviderStreamEvent> {
    const trigger = compaction.stats?.trigger ?? fallbackTrigger;
    yield providerLettaChunk({
      message_type: "event_message",
      event_type: "compaction",
      event_data: { trigger },
    } as never);
    yield providerLettaChunk({
      message_type: "summary_message",
      summary: compaction.summary,
      ...(compaction.stats ? { compaction_stats: compaction.stats } : {}),
    } as never);
  }

  private async *streamOnce(
    input: ProviderTurnInput,
  ): AsyncIterable<ProviderStreamEvent> {
    const tools = toToolSet(input.clientTools);
    const provider = aiSDKProviderKind(
      input.agent.model,
      input.agent.model_settings,
    );
    const uiMessages = await validateUIMessages<LocalMessage>({
      messages: sanitizeUIMessagesForProvider(
        input.uiMessages,
        provider,
        input.agent,
      ),
      tools: tools as never,
    });
    const result = this.runStreamText({
      model:
        this.createModel?.() ??
        createAISDKModelFactoryFromAgent(
          input.agent.model,
          input.agent.model_settings,
          { localProviderAuthStorageDir: this.localProviderAuthStorageDir },
        )(),
      system:
        provider === "openai" &&
        isChatGPTOAuthModel(input.agent.model, input.agent.model_settings)
          ? undefined
          : (input.systemPrompt ?? input.agent.system),
      messages: await convertToModelMessages(uiMessages, { tools }),
      tools,
      providerOptions: buildAISDKProviderOptions(
        input.agent.model,
        input.agent.model_settings,
        { systemPrompt: input.systemPrompt ?? input.agent.system },
      ),
      maxRetries: 0,
      abortSignal: this.abortSignal,
      // We classify and handle stream errors in this adapter; suppress AI SDK's
      // default console.error logging for each error chunk.
      onError: () => {},
    });
    let uiMessageError: unknown;
    const finalUIMessage = captureFinalUIMessage(result, uiMessages).catch(
      (error) => {
        uiMessageError = error;
        return undefined;
      },
    );

    let streamError: unknown;
    let lastUsage: LanguageModelUsage | undefined;
    for await (const part of result.fullStream) {
      if (part.type === "error") {
        if (
          isContextWindowOverflowError(part.error) ||
          isRetryableLocalProviderError(part.error)
        ) {
          streamError = part.error;
          break;
        }
      }
      if (part.type === "finish-step") {
        lastUsage = part.usage;
      }
      if (part.type === "finish") {
        lastUsage ??= part.totalUsage;
      }
      yield providerStreamPart(part);
    }

    if (streamError) {
      await finalUIMessage.catch(() => undefined);
      throw streamError;
    }

    const message = await finalUIMessage;
    if (uiMessageError) throw uiMessageError;
    if (message) {
      yield providerUIMessage(message);
    }
    if (lastUsage && this.onContextUsage) {
      const compaction = await this.onContextUsage(input, lastUsage);
      if (compaction) {
        yield* this.emitCompactionChunks(compaction, "context_window_limit");
      }
    }
  }

  async *stream(input: ProviderTurnInput): AsyncIterable<ProviderStreamEvent> {
    let activeInput = input;
    let contextOverflowCompactions = 0;
    let transientRetries = 0;

    while (true) {
      let emittedModelOutput = false;
      try {
        for await (const event of this.streamOnce(activeInput)) {
          if (isModelOutputEvent(event)) {
            emittedModelOutput = true;
          }
          yield event;
        }
        return;
      } catch (error) {
        if (isContextWindowOverflowError(error)) {
          if (
            !this.onContextWindowOverflow ||
            contextOverflowCompactions >= LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS
          ) {
            throw error;
          }

          const compaction = await this.onContextWindowOverflow(
            activeInput,
            error,
          );
          if (!compaction) throw error;

          contextOverflowCompactions += 1;
          activeInput = {
            ...activeInput,
            uiMessages: compaction.uiMessages,
          };
          yield* this.emitCompactionChunks(
            compaction,
            "context_window_overflow",
          );
          continue;
        }

        if (
          emittedModelOutput ||
          transientRetries >= LOCAL_PROVIDER_MAX_RETRIES ||
          !isRetryableLocalProviderError(error)
        ) {
          throw error;
        }

        transientRetries += 1;
        const delayMs = localProviderRetryDelayMs(error, transientRetries);
        yield providerLettaChunk({
          message_type: "event_message",
          event_type: "retry",
          event_data: {
            attempt: transientRetries,
            max_attempts: LOCAL_PROVIDER_MAX_RETRIES,
            delay_ms: delayMs,
            message: localProviderRetryMessage(error),
          },
        } as never);
        await sleepWithAbort(delayMs, this.abortSignal);
      }
    }
  }
}
