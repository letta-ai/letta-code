import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type CustomToolInputFormat,
  isContextOverflow,
  type Message,
  type Model,
  type SimpleStreamOptions,
  stream,
  streamSimple,
  type ThinkingLevel,
  type ToolDefinition,
  type TSchema,
  Type,
  type Usage,
} from "@earendil-works/pi-ai";
import type { LocalCompactionStats } from "@/backend/local/compaction";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalMessage,
} from "@/backend/local/local-message";
import { isRecord } from "@/utils/type-guards";
import { isContextWindowOverflowError } from "./context-window-overflow";
import {
  isRetryableLocalProviderError,
  localProviderRetryDelayMs,
  localProviderRetryMessage,
} from "./local-provider-errors";
import {
  applyPiEnvOverrides,
  resolvePiModelForAgent,
} from "./pi-model-factory";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./provider-turn-executor";
import {
  providerLettaChunk,
  providerLocalMessage,
  providerStreamPart,
} from "./provider-turn-executor";

const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3;

export type PiStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface PiStreamAdapterOptions {
  stream?: PiStreamFunction;
  abortSignal?: AbortSignal;
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
    usage: Usage,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>;
}

class PiProviderError extends Error {
  readonly assistant: AssistantMessage;
  readonly statusCode?: number;

  constructor(assistant: AssistantMessage) {
    super(assistant.errorMessage ?? "Unknown local provider error");
    this.name = "PiProviderError";
    this.assistant = assistant;
    const status = assistant.diagnostics
      ?.map(
        (diagnostic) =>
          diagnostic.details?.statusCode ?? diagnostic.details?.status,
      )
      .find((value): value is number => typeof value === "number");
    this.statusCode = status;
  }
}

class EmptyPiResponseError extends Error {
  readonly isRetryable = true;

  constructor() {
    super("Received empty content in local provider response.");
    this.name = "EmptyPiResponseError";
  }
}

function hasAssistantOutputContent(message: AssistantMessage): boolean {
  return message.content.some((block) => {
    if (block.type === "toolCall") return true;
    if (block.type === "text") return block.text.trim().length > 0;
    return false;
  });
}

function assertAssistantHasOutputContent(message: AssistantMessage): void {
  if (!hasAssistantOutputContent(message)) {
    throw new EmptyPiResponseError();
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

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonSchemaField(value: unknown): TSchema | undefined {
  return isRecord(value) ? (value as unknown as TSchema) : undefined;
}

function customToolInputFormat(
  value: unknown,
): CustomToolInputFormat | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "text") return { type: "text" };
  if (
    value.type === "grammar" &&
    (value.syntax === "lark" || value.syntax === "regex") &&
    typeof value.definition === "string"
  ) {
    return {
      type: "grammar",
      syntax: value.syntax,
      definition: value.definition,
    };
  }
  return undefined;
}

function toPiTool(value: unknown): ToolDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringField(value.name);
  if (!name) return undefined;

  const description = stringField(value.description) ?? "";
  if (value.type === "custom") {
    const fallback = isRecord(value.fallback) ? value.fallback : undefined;
    const fallbackParameters = jsonSchemaField(fallback?.parameters);
    const format = customToolInputFormat(value.format);
    return {
      type: "custom",
      name,
      description,
      ...(format ? { format } : {}),
      ...(fallback && fallbackParameters
        ? {
            fallback: {
              ...(typeof fallback.description === "string"
                ? { description: fallback.description }
                : {}),
              parameters: fallbackParameters,
            },
          }
        : {}),
    };
  }

  return {
    name,
    description,
    parameters: jsonSchemaField(value.parameters) ?? Type.Object({}),
  };
}

export function toPiTools(
  clientTools: unknown[],
): ToolDefinition[] | undefined {
  const tools: ToolDefinition[] = [];
  for (const value of clientTools) {
    const tool = toPiTool(value);
    if (tool) tools.push(tool);
  }
  return tools.length > 0 ? tools : undefined;
}

const EMPTY_TOOL_RESULT_PLACEHOLDER = "No result provided";

type LocalUserContent = Extract<LocalMessage, { role: "user" }>["content"];
type LocalAssistantContent = Extract<
  LocalMessage,
  { role: "assistant" }
>["content"];
type LocalToolResultContent = Extract<
  LocalMessage,
  { role: "toolResult" }
>["content"];

function isEmptyTextBlock(block: { type: string; text?: unknown }): boolean {
  return (
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim().length === 0
  );
}

function dropEmptyTextBlocks<T extends { type: string; text?: unknown }>(
  content: T[],
): T[] {
  return content.filter((block) => !isEmptyTextBlock(block));
}

function normalizeUserContent(
  content: LocalUserContent,
): LocalUserContent | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAssistantContent(
  content: LocalAssistantContent,
): LocalAssistantContent | undefined {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeToolResultContent(
  content: LocalToolResultContent,
): LocalToolResultContent {
  const normalized = dropEmptyTextBlocks(content);
  return normalized.length > 0
    ? normalized
    : [{ type: "text", text: EMPTY_TOOL_RESULT_PLACEHOLDER }];
}

function toPiMessage(message: LocalMessage): Message | undefined {
  if (message.role === "user") {
    const content = normalizeUserContent(message.content);
    if (!content) return undefined;
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: normalizeToolResultContent(message.content),
      details: message.details,
      isError: message.isError,
      timestamp: message.timestamp,
    } satisfies Message;
  }
  const content = normalizeAssistantContent(message.content);
  if (!content) return undefined;
  return {
    role: "assistant",
    content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    usage: message.usage,
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
  } satisfies Message;
}

function toPiMessages(messages: LocalMessage[]): Message[] {
  let normalized = messages.flatMap((message) => {
    const piMessage = toPiMessage(message);
    return piMessage ? [piMessage] : [];
  });

  // Strip trailing assistant messages after normalization. Providers like
  // Anthropic require the conversation to end with a user or tool-result
  // message, and dropping empty text-only user messages can expose a trailing
  // partial assistant response from a failed turn.
  while (normalized.length > 0 && normalized.at(-1)?.role === "assistant") {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function stripOpenAIResponsesReplayItemIds(
  payload: unknown,
): unknown | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

  let changed = false;
  const input = payload.input.map((item) => {
    if (!isRecord(item) || !("id" in item)) return item;
    const type = item.type;
    if (
      type !== "reasoning" &&
      type !== "message" &&
      type !== "function_call"
    ) {
      return item;
    }

    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });

  return changed ? { ...payload, input } : undefined;
}

function withOpenAIResponsesReplayIdSanitizer(
  existing: SimpleStreamOptions["onPayload"] | undefined,
): SimpleStreamOptions["onPayload"] {
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }

    const sanitized = stripOpenAIResponsesReplayItemIds(next);
    if (sanitized !== undefined) return sanitized;
    return upstreamChanged ? next : undefined;
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function thinkingLevel(value: unknown): ThinkingLevel | undefined {
  const effort = stringValue(value);
  return effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
    ? effort
    : undefined;
}

function reasoningForSettings(
  modelSettings: Record<string, unknown>,
): ThinkingLevel | undefined {
  const thinking = isRecord(modelSettings.thinking)
    ? modelSettings.thinking
    : undefined;
  if (thinking?.type === "disabled") return undefined;
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  return (
    thinkingLevel(nestedReasoning?.reasoning_effort) ??
    thinkingLevel(modelSettings.effort) ??
    thinkingLevel(modelSettings.reasoning_effort)
  );
}

function maxTokensForSettings(
  modelSettings: Record<string, unknown>,
): number | undefined {
  const maxTokens = modelSettings.max_tokens;
  return typeof maxTokens === "number" && Number.isFinite(maxTokens)
    ? maxTokens
    : undefined;
}

function toLocalAssistantMessage(
  message: AssistantMessage,
  input: ProviderTurnInput,
): LocalAssistantMessage {
  return {
    id: message.responseId ?? `local-assistant-${Date.now()}`,
    role: "assistant",
    content: message.content,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
    usage: message.usage ?? emptyLocalUsage(),
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    timestamp: message.timestamp,
    metadata: {
      agent_id: input.agentId,
      conversation_id: input.conversationId,
      provider: {
        provider_id: message.provider,
        model_id: message.model,
        ...(message.responseId ? { response_id: message.responseId } : {}),
        usage: message.usage,
      },
    },
  };
}

function isModelOutputEvent(event: ProviderStreamEvent): boolean {
  if (event.type === "local-message") return true;
  if (event.type !== "provider-part") return false;
  switch (event.part.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

function isOverflowError(error: unknown, contextWindow?: number): boolean {
  if (error instanceof PiProviderError) {
    return isContextOverflow(error.assistant, contextWindow);
  }
  return isContextWindowOverflowError(error);
}

function defaultStream(
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) {
  if (model.api === "bedrock-converse-stream") {
    return stream(model, context, options);
  }
  return streamSimple(model, context, options);
}

export class PiStreamAdapter implements ProviderStreamAdapter {
  private readonly runStream: PiStreamFunction;
  private readonly abortSignal?: AbortSignal;
  private readonly localProviderAuthStorageDir?: string;
  private readonly onContextWindowOverflow?: PiStreamAdapterOptions["onContextWindowOverflow"];
  private readonly onContextUsage?: PiStreamAdapterOptions["onContextUsage"];

  constructor(options: PiStreamAdapterOptions = {}) {
    this.runStream = options.stream ?? defaultStream;
    this.abortSignal = options.abortSignal;
    this.localProviderAuthStorageDir = options.localProviderAuthStorageDir;
    this.onContextWindowOverflow = options.onContextWindowOverflow;
    this.onContextUsage = options.onContextUsage;
  }

  private async *emitCompactionChunks(
    compaction: { summary: string; stats?: LocalCompactionStats },
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
    const tools = toPiTools(input.clientTools);
    const resolved = await resolvePiModelForAgent(
      input.agent.model,
      input.agent.model_settings,
      { localProviderAuthStorageDir: this.localProviderAuthStorageDir },
    );
    const context: Context = {
      systemPrompt: input.systemPrompt ?? input.agent.system,
      messages: toPiMessages(input.uiMessages),
      ...(tools ? { tools } : {}),
    };
    const options: SimpleStreamOptions & Record<string, unknown> = {
      ...resolved.providerOptions,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(this.abortSignal ? { signal: this.abortSignal } : {}),
      maxRetries: 0,
      sessionId: input.conversationId,
      ...(reasoningForSettings(input.agent.model_settings)
        ? { reasoning: reasoningForSettings(input.agent.model_settings) }
        : {}),
      ...(maxTokensForSettings(input.agent.model_settings)
        ? { maxTokens: maxTokensForSettings(input.agent.model_settings) }
        : {}),
      ...(boolValue(input.agent.model_settings.parallel_tool_calls) !==
      undefined
        ? {
            parallelToolCalls: boolValue(
              input.agent.model_settings.parallel_tool_calls,
            ),
          }
        : {}),
    };
    if (resolved.model.api === "openai-responses") {
      // pi-ai replays OpenAI Responses output items from transcript history.
      // Those upstream item IDs (rs_*, msg_*, fc_*) are not retrievable when the
      // request uses store:false, so remove them and replay the full item bodies.
      options.onPayload = withOpenAIResponsesReplayIdSanitizer(
        options.onPayload,
      );
    }

    const restoreEnv = applyPiEnvOverrides(resolved.envOverrides);
    try {
      const result = this.runStream(
        resolved.model as Model<string>,
        context,
        options,
      );

      let streamError: unknown;
      let finalMessage: AssistantMessage | undefined;
      for await (const part of result) {
        if (part.type === "error") {
          const error = new PiProviderError(part.error);
          if (
            isOverflowError(error, resolved.model.contextWindow) ||
            isRetryableLocalProviderError(error)
          ) {
            streamError = error;
            break;
          }
        }
        if (part.type === "done") {
          assertAssistantHasOutputContent(part.message);
          finalMessage = part.message;
          yield providerLocalMessage(
            toLocalAssistantMessage(part.message, input),
          );
        }
        yield providerStreamPart(part);
      }

      if (streamError) throw streamError;
      finalMessage ??= await result.result();
      assertAssistantHasOutputContent(finalMessage);
      if (
        finalMessage.stopReason === "error" ||
        finalMessage.stopReason === "aborted"
      ) {
        throw new PiProviderError(finalMessage);
      }
      if (this.onContextUsage) {
        const compaction = await this.onContextUsage(input, finalMessage.usage);
        if (compaction) {
          yield* this.emitCompactionChunks(compaction, "context_window_limit");
        }
      }
    } finally {
      restoreEnv();
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
          if (isModelOutputEvent(event)) emittedModelOutput = true;
          yield event;
        }
        return;
      } catch (error) {
        if (isOverflowError(error)) {
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
          activeInput = { ...activeInput, uiMessages: compaction.uiMessages };
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
