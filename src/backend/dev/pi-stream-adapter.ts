import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";

import {
  emptyLocalUsage,
  type LocalAssistantMessage,
  type LocalCompactionStats,
  type LocalMessage,
} from "@/backend/local/local-message";
import { resolveAvailableLocalModelForTurn } from "@/backend/local/local-model-config";
import { debugLog } from "@/utils/debug";
import { isRecord } from "@/utils/type-guards";
import { isContextWindowOverflowError } from "./context-window-overflow";
import {
  isRetryableLocalProviderError,
  localProviderRetryDelayMs,
  localProviderRetryMessage,
  normalizeLocalProviderError,
} from "./local-provider-errors";
import {
  elideImagePayloadsForProviderRetry,
  isOversizedPayloadTransportFailure,
} from "./pi-image-elision";
import { toPiMessages, toPiTools } from "./pi-messages";
import {
  applyPiEnvOverrides,
  reasoningForSettings,
  resolvePiModelForAgent,
  samplingOptionsForSettings,
} from "./pi-model-factory";
import { LocalPiModelsRuntime } from "./pi-models-runtime";
import { resolvePiRequestHeaders } from "./pi-request-headers";
import { isPiModelOutputEvent } from "./pi-stream-output";
import type {
  LlmEndErrorInfo,
  LlmEndInfo,
  LlmStartInfo,
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./provider-turn-executor";
import {
  estimateProviderContextTokens,
  estimateProviderPromptFloorTokens,
  providerLettaChunk,
  providerLocalMessage,
  providerStreamPart,
  shouldCompactForContextPressure,
} from "./provider-turn-executor";

const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_PROVIDER_ADAPTIVE_IMAGE_ELISION_AFTER_RETRIES =
  LOCAL_PROVIDER_MAX_RETRIES - 1;
const LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3;

export type PiStreamFunction = (
  model: Model<string>,
  context: Context,
  options?: SimpleStreamOptions & Record<string, unknown>,
) => AsyncIterable<AssistantMessageEvent> & {
  result(): Promise<AssistantMessage>;
};

export interface LocalContextPressure {
  contextTokens: number;
  contextWindow: number;
}

interface LocalCompactionResult {
  uiMessages: LocalMessage[];
  summary: string;
  stats?: LocalCompactionStats;
}

export interface PiStreamAdapterOptions {
  stream?: PiStreamFunction;
  abortSignal?: AbortSignal;
  localProviderAuthStorageDir?: string;
  modelsRuntime?: LocalPiModelsRuntime;
  onContextWindowOverflow?: (
    input: ProviderTurnInput,
    error: unknown,
  ) => Promise<{
    uiMessages: LocalMessage[];
    summary: string;
    stats?: LocalCompactionStats;
  } | null>;
  onContextPressure?: (
    input: ProviderTurnInput,
    pressure: LocalContextPressure,
  ) => Promise<LocalCompactionResult | null>;
  onLlmStart?: (info: LlmStartInfo) => void | Promise<void>;
  onLlmEnd?: (info: LlmEndInfo) => void | Promise<void>;
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

function withAnthropicOutputEffort(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  effort: string | undefined,
): SimpleStreamOptions["onPayload"] | undefined {
  if (!effort) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) return upstreamChanged ? next : undefined;
    const outputConfig = isRecord(next.output_config) ? next.output_config : {};
    return {
      ...next,
      output_config: {
        ...outputConfig,
        effort,
      },
    };
  };
}

function assertPromptFloorFitsContextWindow(
  input: ProviderTurnInput,
  model: { id: string; provider?: string; contextWindow?: number },
): void {
  const contextWindow = model.contextWindow;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return;
  }
  const floorTokens = estimateProviderPromptFloorTokens(input);
  if (floorTokens <= contextWindow) return;

  const remedy =
    model.provider === "ollama"
      ? `Raise the served window (for example OLLAMA_CONTEXT_LENGTH=${nextPowerOfTwoAtLeast(floorTokens)} ollama serve)`
      : "Raise the engine's context window";
  throw new Error(
    `The system prompt and tool definitions need about ${floorTokens.toLocaleString()} tokens, ` +
      `but "${model.id}" is served with a ${contextWindow.toLocaleString()}-token context window. ` +
      `The engine would silently truncate the prompt, dropping memory and persona before the model sees them. ` +
      `${remedy}, or reduce what the prompt carries (fewer installed skills, a smaller toolset).`,
  );
}

function nextPowerOfTwoAtLeast(value: number): number {
  let size = 8192;
  while (size < value && size < 1_048_576) size *= 2;
  return size;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function anthropicEffortForSettings(
  modelSettings: Record<string, unknown>,
): string | undefined {
  const nestedReasoning = isRecord(modelSettings.reasoning)
    ? modelSettings.reasoning
    : undefined;
  return (
    stringValue(modelSettings.effort) ??
    stringValue(nestedReasoning?.reasoning_effort) ??
    stringValue(modelSettings.reasoning_effort)
  );
}

function serviceTierForSettings(
  model: Model<string>,
  modelSettings: Record<string, unknown>,
): "priority" | undefined {
  if (model.api !== "openai-codex-responses") return undefined;
  return modelSettings.service_tier === "priority" ? "priority" : undefined;
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
    ...(message.providerThinkingLevel
      ? { providerThinkingLevel: message.providerThinkingLevel }
      : {}),
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

function llmEndErrorFromError(error: unknown): {
  error: LlmEndErrorInfo;
  stopReason: string;
} {
  const info = normalizeLocalProviderError(error);
  return {
    error: {
      message: info.message,
      detail: info.detail,
      errorType: info.error_type,
      retryable: info.retryable,
    },
    stopReason: info.stop_reason,
  };
}

function isOverflowError(error: unknown, contextWindow?: number): boolean {
  if (error instanceof PiProviderError) {
    return isContextOverflow(error.assistant, contextWindow);
  }
  return isContextWindowOverflowError(error);
}

export class PiStreamAdapter implements ProviderStreamAdapter {
  private readonly runStream: PiStreamFunction;
  private readonly abortSignal?: AbortSignal;
  private readonly localProviderAuthStorageDir?: string;
  private readonly modelsRuntime: LocalPiModelsRuntime;
  private readonly onContextWindowOverflow?: PiStreamAdapterOptions["onContextWindowOverflow"];
  private readonly onContextPressure?: PiStreamAdapterOptions["onContextPressure"];
  private readonly onLlmStart?: PiStreamAdapterOptions["onLlmStart"];
  private readonly onLlmEnd?: PiStreamAdapterOptions["onLlmEnd"];

  constructor(options: PiStreamAdapterOptions = {}) {
    this.modelsRuntime =
      options.modelsRuntime ??
      new LocalPiModelsRuntime({
        storageDir: options.localProviderAuthStorageDir,
      });
    this.runStream =
      options.stream ??
      ((model, context, streamOptions) =>
        model.api === "bedrock-converse-stream"
          ? this.modelsRuntime.stream(model, context, streamOptions as never)
          : this.modelsRuntime.streamSimple(model, context, streamOptions));
    this.abortSignal = options.abortSignal;
    this.localProviderAuthStorageDir = options.localProviderAuthStorageDir;
    this.onContextWindowOverflow = options.onContextWindowOverflow;
    this.onContextPressure = options.onContextPressure;
    this.onLlmStart = options.onLlmStart;
    this.onLlmEnd = options.onLlmEnd;
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

  private async compactBeforeProviderCall(
    input: ProviderTurnInput,
  ): Promise<LocalCompactionResult | null> {
    if (!this.onContextPressure) return null;

    const contextTokens = estimateProviderContextTokens(input);
    if (contextTokens === undefined) return null;

    const localModel = await resolveAvailableLocalModelForTurn({
      model: input.agent.model,
      modelSettings: input.agent.model_settings,
      storageDir: this.localProviderAuthStorageDir,
      modelsRuntime: this.modelsRuntime,
    });
    const resolved = await resolvePiModelForAgent(
      localModel.model,
      localModel.modelSettings,
      {
        localProviderAuthStorageDir: this.localProviderAuthStorageDir,
        modelsRuntime: this.modelsRuntime,
        ...(this.abortSignal ? { abortSignal: this.abortSignal } : {}),
      },
    );
    const contextWindow = resolved.model.contextWindow;
    if (!shouldCompactForContextPressure({ contextTokens, contextWindow })) {
      return null;
    }

    return this.onContextPressure(input, { contextTokens, contextWindow });
  }

  private async *streamOnce(
    input: ProviderTurnInput,
  ): AsyncIterable<ProviderStreamEvent> {
    const tools = toPiTools(input.clientTools);
    const localModel = await resolveAvailableLocalModelForTurn({
      model: input.agent.model,
      modelSettings: input.agent.model_settings,
      storageDir: this.localProviderAuthStorageDir,
      modelsRuntime: this.modelsRuntime,
    });
    const resolved = await resolvePiModelForAgent(
      localModel.model,
      localModel.modelSettings,
      {
        localProviderAuthStorageDir: this.localProviderAuthStorageDir,
        modelsRuntime: this.modelsRuntime,
        ...(this.abortSignal ? { abortSignal: this.abortSignal } : {}),
      },
    );
    assertPromptFloorFitsContextWindow(input, resolved.model);
    const messages = toPiMessages(input.uiMessages);
    if (input.midConversationSystemPrompt) {
      messages.push({
        role: "system",
        content: input.midConversationSystemPrompt,
        timestamp: Date.now(),
      });
    }
    const context: Context = {
      systemPrompt: input.systemPrompt ?? input.agent.system,
      messages,
      ...(tools ? { tools } : {}),
    };
    const reasoning = reasoningForSettings(
      input.agent.model_settings,
      input.agent.model,
      resolved.model,
    );
    const headers = resolvePiRequestHeaders({
      provider: resolved.model.provider,
      configuredHeaders: resolved.headers,
      conversationId: input.conversationId,
      requestKind: "turn",
    });
    const options: SimpleStreamOptions & Record<string, unknown> = {
      ...resolved.providerOptions,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
      headers,
      ...(this.abortSignal ? { signal: this.abortSignal } : {}),
      maxRetries: 0,
      sessionId: input.conversationId,
      ...samplingOptionsForSettings(input.agent.model_settings),
      ...(reasoning ? { reasoning } : {}),
      ...(serviceTierForSettings(resolved.model, input.agent.model_settings)
        ? {
            serviceTier: serviceTierForSettings(
              resolved.model,
              input.agent.model_settings,
            ),
          }
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
    const verbosity = input.agent.model_settings.verbosity;
    if (
      (resolved.model.api === "openai-responses" ||
        resolved.model.api === "openai-codex-responses") &&
      (verbosity === "low" || verbosity === "medium" || verbosity === "high")
    ) {
      const existing = options.onPayload;
      options.onPayload = async (payload, model) => {
        const next = (await existing?.(payload, model)) ?? payload;
        if (!isRecord(next)) return next;
        return {
          ...next,
          text: { ...(isRecord(next.text) ? next.text : {}), verbosity },
        };
      };
    }
    if (resolved.model.api === "openai-responses") {
      options.onPayload = withOpenAIResponsesReplayIdSanitizer(
        options.onPayload,
      );
    }
    if (
      resolved.model.api === "anthropic-messages" &&
      (
        resolved.model.compat as
          | { supportsMidConvoEffort?: boolean }
          | undefined
      )?.supportsMidConvoEffort !== true
    ) {
      if (
        resolved.model.id.includes("claude-fable-5") &&
        anthropicEffortForSettings(input.agent.model_settings) === "max"
      ) {
        options.onPayload = withAnthropicOutputEffort(options.onPayload, "max");
      }
    }

    const restoreEnv = applyPiEnvOverrides(resolved.envOverrides);
    const llmStartedAt = Date.now();
    let llmEnded = false;
    const emitLlmEnd = async (
      info: Omit<
        LlmEndInfo,
        "agentId" | "conversationId" | "durationMs" | "model"
      >,
    ): Promise<void> => {
      llmEnded = true;
      await this.onLlmEnd?.({
        agentId: input.agentId,
        conversationId: input.conversationId,
        model: input.agent.model,
        durationMs: Date.now() - llmStartedAt,
        ...info,
      });
    };
    try {
      await this.onLlmStart?.({
        agentId: input.agentId,
        conversationId: input.conversationId,
        model: input.agent.model,
        messageCount: context.messages.length,
        contextWindow: resolved.model.contextWindow,
      });
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
          if (part.error.content.length > 0) {
            yield providerLocalMessage(
              toLocalAssistantMessage(part.error, input),
            );
          }
        }
        if (part.type === "done") {
          finalMessage = part.message;
          yield providerLocalMessage(
            toLocalAssistantMessage(part.message, input),
          );
        }
        yield providerStreamPart(part, resolved.model);
      }

      if (streamError) throw streamError;
      finalMessage ??= await result.result();
      const finalMessageError =
        finalMessage.stopReason === "error" ||
        finalMessage.stopReason === "aborted"
          ? llmEndErrorFromError(new PiProviderError(finalMessage)).error
          : undefined;
      await emitLlmEnd({
        stopReason: finalMessage.stopReason,
        usage: {
          promptTokens: finalMessage.usage.input,
          completionTokens: finalMessage.usage.output,
          totalTokens: finalMessage.usage.totalTokens,
        },
        ...(finalMessageError ? { error: finalMessageError } : {}),
      });
      if (
        finalMessage.stopReason === "error" ||
        finalMessage.stopReason === "aborted"
      ) {
        throw new PiProviderError(finalMessage);
      }
    } catch (error) {
      if (!llmEnded) {
        const endError = llmEndErrorFromError(error);
        await emitLlmEnd({
          stopReason: endError.stopReason,
          usage: null,
          error: endError.error,
        });
      }
      throw error;
    } finally {
      restoreEnv();
    }
  }

  async *stream(input: ProviderTurnInput): AsyncIterable<ProviderStreamEvent> {
    let activeInput = input;
    let preflightCompactionChecked = false;
    let contextOverflowCompactions = 0;
    let transientRetries = 0;

    while (true) {
      if (!preflightCompactionChecked) {
        preflightCompactionChecked = true;
        const compaction = await this.compactBeforeProviderCall(activeInput);
        if (compaction) {
          activeInput = { ...activeInput, uiMessages: compaction.uiMessages };
          yield* this.emitCompactionChunks(compaction, "context_window_limit");
          continue;
        }
      }

      let emittedModelOutput = false;
      let emittedLocalMessage = false;
      try {
        for await (const event of this.streamOnce(activeInput)) {
          if (isPiModelOutputEvent(event)) emittedModelOutput = true;
          if (event.type === "local-message") emittedLocalMessage = true;
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

        const retryableTransportError = isRetryableLocalProviderError(error);

        if (
          retryableTransportError &&
          !emittedModelOutput &&
          this.onContextWindowOverflow &&
          contextOverflowCompactions < LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS &&
          isOversizedPayloadTransportFailure(activeInput)
        ) {
          const imageElision = elideImagePayloadsForProviderRetry(activeInput);
          if (imageElision) {
            debugLog(
              "pi-stream",
              "oversized payload transport failure: elided %d image(s) (%d -> %d bytes, limit %d, target %d) from provider retry context",
              imageElision.elidedImages,
              imageElision.beforeBytes,
              imageElision.afterBytes,
              imageElision.requestByteLimit,
              imageElision.requestByteTarget,
            );
            activeInput = imageElision.input;
            transientRetries = 0;
            continue;
          }

          let compaction: Awaited<
            ReturnType<NonNullable<typeof this.onContextWindowOverflow>>
          > = null;
          try {
            compaction = await this.onContextWindowOverflow(activeInput, error);
          } catch {
            compaction = null;
          }
          if (compaction) {
            contextOverflowCompactions += 1;
            activeInput = { ...activeInput, uiMessages: compaction.uiMessages };
            yield* this.emitCompactionChunks(
              compaction,
              "context_window_overflow",
            );
            continue;
          }
        }

        if (
          retryableTransportError &&
          !emittedModelOutput &&
          transientRetries >=
            LOCAL_PROVIDER_ADAPTIVE_IMAGE_ELISION_AFTER_RETRIES
        ) {
          const imageElision = elideImagePayloadsForProviderRetry(activeInput, {
            allowUnderLimit: true,
          });
          if (imageElision) {
            debugLog(
              "pi-stream",
              "retryable transport failures persisted: adaptively elided %d image(s) (%d -> %d bytes, limit %d, target %d) from provider retry context",
              imageElision.elidedImages,
              imageElision.beforeBytes,
              imageElision.afterBytes,
              imageElision.requestByteLimit,
              imageElision.requestByteTarget,
            );
            activeInput = imageElision.input;
            transientRetries = 0;
            continue;
          }
        }

        if (
          emittedModelOutput ||
          transientRetries >= LOCAL_PROVIDER_MAX_RETRIES ||
          !retryableTransportError
        ) {
          if (
            emittedModelOutput &&
            !emittedLocalMessage &&
            error instanceof PiProviderError &&
            error.assistant.content.length > 0
          ) {
            yield providerLocalMessage(
              toLocalAssistantMessage(error.assistant, activeInput),
            );
          }
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
