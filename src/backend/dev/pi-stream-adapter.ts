import { createHmac, randomBytes } from "node:crypto";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  isContextOverflow,
  type Message,
  type Model,
  type SimpleStreamOptions,
  stream,
  streamSimple,
  type Tool,
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
import { removeOrphanLocalToolResults } from "@/backend/local/local-message-projection";
import { resolveAvailableLocalModelForTurn } from "@/backend/local/local-model-config";
import type { ClientTool } from "@/tools/manager";
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
  applyPiEnvOverrides,
  reasoningForSettings,
  resolvePiModelForAgent,
} from "./pi-model-factory";
import type {
  LlmEndErrorInfo,
  LlmEndInfo,
  LlmStartInfo,
  ProviderStreamAdapter,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "./provider-turn-executor";
import {
  estimateProviderRequestBytes,
  providerLettaChunk,
  providerLocalMessage,
  providerStreamPart,
} from "./provider-turn-executor";

const LOCAL_PROVIDER_MAX_RETRIES = 3;
const LOCAL_PROVIDER_ADAPTIVE_IMAGE_ELISION_AFTER_RETRIES =
  LOCAL_PROVIDER_MAX_RETRIES - 1;
const LOCAL_CONTEXT_OVERFLOW_MAX_COMPACTIONS = 3;
// Classifier threshold for oversized request payloads. This is a transport
// limit, not a token limit: providers accept image-heavy requests whose
// semantic token cost is small, but large raw bodies cause generic transport
// failures (connection errors, SSE header timeouts) instead of clean,
// classifiable overflow errors. When a retryable transport error occurs and
// the serialized payload exceeds this threshold, we treat it as context
// overflow (compact + retry) instead of retrying the same oversized payload.
// It never blocks a request preemptively. Empirically (local-conv-48): ~7MB
// of in-context images still succeeded against Anthropic at ~400k context
// tokens, while ~11.8MB failed with "Connection error." on every provider.
// 8MB keeps headroom under Anthropic's documented 32MB cap while staying
// above known-good payloads. Local networks can fail below that threshold, so
// LETTA_LOCAL_REQUEST_BYTE_LIMIT can lower the reactive classifier in dev.
const DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT = 8_000_000;
const LOCAL_PROVIDER_REQUEST_BYTE_LIMIT_ENV = "LETTA_LOCAL_REQUEST_BYTE_LIMIT";

function localProviderRequestByteLimit(): number {
  const raw = process.env[LOCAL_PROVIDER_REQUEST_BYTE_LIMIT_ENV];
  if (!raw) return DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOCAL_PROVIDER_REQUEST_BYTE_LIMIT;
  }
  return Math.floor(parsed);
}

function localProviderRequestByteTarget(
  limit = localProviderRequestByteLimit(),
) {
  return Math.floor(limit * 0.75);
}

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

function toPiMessages(messages: readonly LocalMessage[]): Message[] {
  const providerSafeMessages = removeOrphanLocalToolResults(messages).messages;
  let normalized = providerSafeMessages.flatMap((message) => {
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

function withMidConversationSystemPrompt(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  systemPrompt: string | undefined,
): SimpleStreamOptions["onPayload"] {
  if (!systemPrompt) return existing;
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (model.id !== "claude-opus-4-8" || !isRecord(next)) {
      return upstreamChanged ? next : undefined;
    }
    const messages = Array.isArray(next.messages) ? next.messages : undefined;
    if (!messages) return upstreamChanged ? next : undefined;
    return {
      ...next,
      messages: [...messages, { role: "system", content: systemPrompt }],
    };
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

const OPENROUTER_TRACE_FIELD_LIMIT = 128;
let openRouterTraceHmacSecret: Buffer | undefined;

function openRouterTraceValue(value: string): string {
  return value.slice(0, OPENROUTER_TRACE_FIELD_LIMIT);
}

function openRouterTraceSecret(): Buffer {
  openRouterTraceHmacSecret ??= randomBytes(32);
  return openRouterTraceHmacSecret;
}

function openRouterTracePseudonym(purpose: string, value: string): string {
  return openRouterTraceValue(
    createHmac("sha256", openRouterTraceSecret())
      .update(`openrouter-broadcast:${purpose}:`)
      .update(value)
      .digest("hex"),
  );
}

function isTelemetryOptedOut(): boolean {
  const telem = process.env.LETTA_CODE_TELEM;
  return telem === "0" || telem === "false" || process.env.DO_NOT_TRACK === "1";
}

export function withOpenRouterSessionHeader(
  headers: Record<string, string> | undefined,
  pseudonymousSessionId: string,
): Record<string, string> {
  const safeHeaders = Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([key]) => key.toLowerCase() !== "x-session-id",
    ),
  );
  return {
    ...safeHeaders,
    "x-session-id": pseudonymousSessionId,
  };
}

function withOpenRouterBroadcastTraceData(
  existing: SimpleStreamOptions["onPayload"] | undefined,
  input: ProviderTurnInput,
  generationName: string,
): SimpleStreamOptions["onPayload"] {
  const pseudonymousSessionId = openRouterTracePseudonym(
    "conversation",
    input.conversationId,
  );
  return async (payload, model) => {
    let next = payload;
    let upstreamChanged = false;
    const upstream = await existing?.(payload, model);
    if (upstream !== undefined) {
      next = upstream;
      upstreamChanged = true;
    }
    if (!isRecord(next)) return upstreamChanged ? next : undefined;

    const existingTrace = isRecord(next.trace) ? next.trace : {};
    return {
      ...next,
      session_id: pseudonymousSessionId,
      trace: {
        ...existingTrace,
        trace_id: pseudonymousSessionId,
        trace_name: "letta-code",
        span_name: "agent-turn",
        generation_name: generationName,
      },
    };
  };
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

function maxTokensForSettings(
  modelSettings: Record<string, unknown>,
): number | undefined {
  const maxTokens = modelSettings.max_tokens;
  return typeof maxTokens === "number" && Number.isFinite(maxTokens)
    ? maxTokens
    : undefined;
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

// Letta Code addition with no Pi analog. Pi compacts reactively on clean,
// classifiable provider overflow errors (`isContextOverflow`, including
// Anthropic 413 `request_too_large`). But oversized payloads frequently kill
// the transport from a local device before any classifiable response arrives
// ("Connection error.", SSE header timeouts), which the retry classifier
// treats as transient — retrying the same oversized payload forever. Pi has
// the same gap (earendil-works/pi #2810, #4642, #5369: "permanently bricking
// sessions"). When a retryable transport failure occurs and the payload is
// measurably oversized, classify it as context overflow so it enters the same
// compaction path instead of the retry loop. This only ever runs after a real
// provider failure; it never preemptively blocks a request.
function isOversizedPayloadTransportFailure(input: ProviderTurnInput): boolean {
  const requestBytes = estimateProviderRequestBytes(input);
  const requestByteLimit = localProviderRequestByteLimit();
  return requestBytes !== undefined && requestBytes > requestByteLimit;
}

interface ImageElisionCandidate {
  messageIndex: number;
  blockIndex: number;
  mimeType?: string;
  bytes: number;
}

interface ImagePayloadElision {
  input: ProviderTurnInput;
  beforeBytes: number;
  afterBytes: number;
  requestByteLimit: number;
  requestByteTarget: number;
  elidedImages: number;
  elidedBytes: number;
}

function imagePayloadBytes(data: unknown): number {
  return typeof data === "string" ? data.length : 0;
}

function imageElisionPlaceholder(mimeType: string | undefined, bytes: number) {
  const mb = (bytes / 1_000_000).toFixed(1);
  return `[Image omitted from this provider retry to reduce local request size: ${
    mimeType ?? "image"
  }, ~${mb}MB. The original image remains stored in conversation history.]`;
}

function imageElisionCandidates(
  messages: readonly LocalMessage[],
): ImageElisionCandidate[] {
  const candidates: ImageElisionCandidate[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "user" && message.role !== "toolResult") return;
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type !== "image") return;
      const bytes = imagePayloadBytes(block.data);
      if (bytes <= 0) return;
      candidates.push({
        messageIndex,
        blockIndex,
        mimeType: block.mimeType,
        bytes,
      });
    });
  });
  // Prefer removing older images first; within a single message, remove larger
  // blobs first. If the request is still too large, this naturally proceeds to
  // newer images as needed.
  return candidates.sort(
    (a, b) =>
      a.messageIndex - b.messageIndex ||
      b.bytes - a.bytes ||
      a.blockIndex - b.blockIndex,
  );
}

function elideImagePayload(
  messages: readonly LocalMessage[],
  candidate: ImageElisionCandidate,
): LocalMessage[] {
  const message = messages[candidate.messageIndex];
  if (!message) return [...messages];
  if (message.role !== "user" && message.role !== "toolResult") {
    return [...messages];
  }
  if (!Array.isArray(message.content)) return [...messages];
  const block = message.content[candidate.blockIndex];
  if (block?.type !== "image") return [...messages];

  const content = [...message.content];
  content[candidate.blockIndex] = {
    type: "text",
    text: imageElisionPlaceholder(candidate.mimeType, candidate.bytes),
  };
  const next = [...messages];
  next[candidate.messageIndex] = { ...message, content } as LocalMessage;
  return next;
}

function elideImagePayloadsForProviderRetry(
  input: ProviderTurnInput,
  options: { allowUnderLimit?: boolean } = {},
): ImagePayloadElision | null {
  const beforeBytes = estimateProviderRequestBytes(input);
  const requestByteLimit = localProviderRequestByteLimit();
  if (
    beforeBytes === undefined ||
    (!options.allowUnderLimit && beforeBytes <= requestByteLimit)
  ) {
    return null;
  }
  const requestByteTarget = options.allowUnderLimit
    ? Math.min(
        localProviderRequestByteTarget(requestByteLimit),
        Math.floor(beforeBytes * 0.75),
      )
    : localProviderRequestByteTarget(requestByteLimit);

  const candidates = imageElisionCandidates(input.uiMessages);
  if (candidates.length === 0) return null;

  let uiMessages = input.uiMessages;
  let afterBytes = beforeBytes;
  let elidedImages = 0;
  let elidedBytes = 0;
  for (const candidate of candidates) {
    if (afterBytes <= requestByteTarget) break;
    uiMessages = elideImagePayload(uiMessages, candidate);
    elidedImages += 1;
    elidedBytes += candidate.bytes;
    afterBytes =
      estimateProviderRequestBytes({ ...input, uiMessages }) ?? afterBytes;
  }

  if (elidedImages === 0 || afterBytes >= beforeBytes) return null;
  return {
    input: { ...input, uiMessages },
    beforeBytes,
    afterBytes,
    requestByteLimit,
    requestByteTarget,
    elidedImages,
    elidedBytes,
  };
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
  private readonly onLlmStart?: PiStreamAdapterOptions["onLlmStart"];
  private readonly onLlmEnd?: PiStreamAdapterOptions["onLlmEnd"];

  constructor(options: PiStreamAdapterOptions = {}) {
    this.runStream = options.stream ?? defaultStream;
    this.abortSignal = options.abortSignal;
    this.localProviderAuthStorageDir = options.localProviderAuthStorageDir;
    this.onContextWindowOverflow = options.onContextWindowOverflow;
    this.onContextUsage = options.onContextUsage;
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

  private async *streamOnce(
    input: ProviderTurnInput,
  ): AsyncIterable<ProviderStreamEvent> {
    const tools = toPiTools(input.clientTools);
    const localModel = await resolveAvailableLocalModelForTurn({
      model: input.agent.model,
      modelSettings: input.agent.model_settings,
      storageDir: this.localProviderAuthStorageDir,
    });
    const resolved = await resolvePiModelForAgent(
      localModel.model,
      localModel.modelSettings,
      { localProviderAuthStorageDir: this.localProviderAuthStorageDir },
    );
    const context: Context = {
      systemPrompt: input.systemPrompt ?? input.agent.system,
      messages: toPiMessages(input.uiMessages),
      ...(tools ? { tools } : {}),
    };
    const pseudonymousOpenRouterSessionId =
      resolved.provider === "openrouter" && !isTelemetryOptedOut()
        ? openRouterTracePseudonym("conversation", input.conversationId)
        : undefined;
    const sessionId =
      resolved.provider === "openrouter"
        ? pseudonymousOpenRouterSessionId
        : input.conversationId;
    const headers = pseudonymousOpenRouterSessionId
      ? withOpenRouterSessionHeader(
          resolved.headers,
          pseudonymousOpenRouterSessionId,
        )
      : resolved.headers;
    const options: SimpleStreamOptions & Record<string, unknown> = {
      ...resolved.providerOptions,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
      ...(headers ? { headers } : {}),
      ...(this.abortSignal ? { signal: this.abortSignal } : {}),
      maxRetries: 0,
      ...(sessionId ? { sessionId } : {}),
      ...(reasoningForSettings(input.agent.model_settings)
        ? { reasoning: reasoningForSettings(input.agent.model_settings) }
        : {}),
      ...(maxTokensForSettings(input.agent.model_settings)
        ? { maxTokens: maxTokensForSettings(input.agent.model_settings) }
        : {}),
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
    if (pseudonymousOpenRouterSessionId) {
      options.onPayload = withOpenRouterBroadcastTraceData(
        options.onPayload,
        input,
        resolved.model.id,
      );
    }
    if (resolved.model.api === "openai-responses") {
      // pi-ai replays OpenAI Responses output items from transcript history.
      // Those upstream item IDs (rs_*, msg_*, fc_*) are not retrievable when the
      // request uses store:false, so remove them and replay the full item bodies.
      options.onPayload = withOpenAIResponsesReplayIdSanitizer(
        options.onPayload,
      );
    }
    if (resolved.model.api === "anthropic-messages") {
      options.onPayload = withMidConversationSystemPrompt(
        options.onPayload,
        input.midConversationSystemPrompt,
      );
      if (
        resolved.model.id.includes("claude-fable-5") &&
        anthropicEffortForSettings(input.agent.model_settings) === "max"
      ) {
        // pi-ai's public ThinkingLevel type currently tops out at xhigh, but
        // Anthropic accepts Fable's max effort through output_config.effort.
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
      if (this.onContextUsage) {
        const compaction = await this.onContextUsage(input, finalMessage.usage);
        if (compaction) {
          yield* this.emitCompactionChunks(compaction, "context_window_limit");
        }
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

        const retryableTransportError = isRetryableLocalProviderError(error);

        // Oversized-payload classification: a retryable transport failure on a
        // payload we can measure as oversized will keep failing — compact
        // instead of retrying the same bytes. See comment on
        // isOversizedPayloadTransportFailure.
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

          // Unlike the provider-reported overflow branch above, the original
          // error here is retryable. If compaction itself fails (for example
          // the summarizer model call errors), fall back to the normal
          // transient retry path instead of replacing a retryable transport
          // error with a non-retryable compaction error.
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

        // Adaptive image elision: a fixed byte limit cannot capture a user's
        // current uplink. If a retryable transport error repeats before any
        // model output, shed provider-context-only image bytes even when the
        // request is below the configured classifier threshold.
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
