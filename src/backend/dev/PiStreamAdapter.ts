import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  isContextOverflow,
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple,
  type ThinkingLevel,
  type Tool,
  type TSchema,
  Type,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ClientTool } from "../../tools/manager";
import type { LocalCompactionStats } from "../local/compaction";
import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalMessage,
} from "../local/LocalMessage";
import { isContextWindowOverflowError } from "./contextWindowOverflow";
import {
  isRetryableLocalProviderError,
  localProviderRetryDelayMs,
  localProviderRetryMessage,
} from "./LocalProviderErrors";
import { resolvePiModelForAgent } from "./PiModelFactory";
import type {
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./ProviderTurnExecutor";
import {
  providerLettaChunk,
  providerLocalMessage,
  providerStreamPart,
} from "./ProviderTurnExecutor";

const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3;

export type PiStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function toPiTools(clientTools: unknown[]): Tool[] | undefined {
  const tools: Tool[] = [];
  for (const value of clientTools) {
    if (!isClientTool(value)) continue;
    const schema = isRecord(value.parameters)
      ? (value.parameters as unknown as TSchema)
      : Type.Object({});
    tools.push({
      name: value.name,
      description: value.description ?? "",
      parameters: schema,
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function toPiMessages(messages: LocalMessage[]): Message[] {
  return messages.map((message) => {
    if (message.role === "user") {
      return {
        role: "user",
        content: message.content,
        timestamp: message.timestamp,
      } satisfies Message;
    }
    if (message.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content,
        details: message.details,
        isError: message.isError,
        timestamp: message.timestamp,
      } satisfies Message;
    }
    return {
      role: "assistant",
      content: message.content,
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel
        ? { responseModel: message.responseModel }
        : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      ...(message.diagnostics ? { diagnostics: message.diagnostics } : {}),
      usage: message.usage,
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      timestamp: message.timestamp,
    } satisfies Message;
  });
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
  options?: SimpleStreamOptions,
) {
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
    const resolved = resolvePiModelForAgent(
      input.agent.model,
      input.agent.model_settings,
      { localProviderAuthStorageDir: this.localProviderAuthStorageDir },
    );
    const context: Context = {
      systemPrompt: input.systemPrompt ?? input.agent.system,
      messages: toPiMessages(input.uiMessages),
      ...(tools ? { tools } : {}),
    };
    const options: SimpleStreamOptions = {
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
        finalMessage = part.message;
        yield providerLocalMessage(
          toLocalAssistantMessage(part.message, input),
        );
      }
      yield providerStreamPart(part);
    }

    if (streamError) throw streamError;
    finalMessage ??= await result.result();
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
