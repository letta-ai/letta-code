import { randomUUID } from "node:crypto";
import type { AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import {
  contextTokensFromLocalUsage,
  estimateLocalContextTokens,
} from "@/backend/local/local-context-estimate";
import type { LocalMessage } from "@/backend/local/local-message";
import type {
  LocalAgentRecord,
  StoredMessage,
} from "@/backend/local/local-store";
import {
  attachLocalMessage,
  markLocalStateChunkOnly,
  type ProviderStreamPart,
} from "@/backend/local/local-stream-chunks";
import type {
  HeadlessTurnBody,
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "./headless-turn-executor";
import { normalizeLocalProviderError } from "./local-provider-errors";

export interface ProviderTurnInput {
  conversationId: string;
  agentId: string;
  agent: LocalAgentRecord;
  systemPrompt?: string;
  midConversationSystemPrompt?: string;
  body: HeadlessTurnBody;
  history: StoredMessage[];
  uiMessages: LocalMessage[];
  clientTools: unknown[];
  clientSkills: unknown[];
}

/** Provider-request start info emitted at the model-call boundary. */
export interface LlmStartInfo {
  agentId: string;
  conversationId: string;
  model: string;
  messageCount: number;
  contextWindow: number;
}

export interface LlmEndErrorInfo {
  message: string;
  detail: string;
  errorType: "llm_error" | "local_backend_error";
  retryable: boolean;
}

/** Provider-request completion info emitted once a final message is produced. */
export interface LlmEndInfo {
  agentId: string;
  conversationId: string;
  model: string;
  stopReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  durationMs: number;
  error?: LlmEndErrorInfo;
}

export type ProviderStreamEvent =
  | { type: "provider-part"; part: ProviderStreamPart }
  | { type: "local-message"; message: LocalMessage }
  | { type: "letta-chunk"; chunk: LettaStreamingResponse }
  | { type: "error"; error: unknown };

export function providerStreamPart(
  part: ProviderStreamPart,
): ProviderStreamEvent {
  return { type: "provider-part", part };
}

export function providerLocalMessage(
  message: LocalMessage,
): ProviderStreamEvent {
  return { type: "local-message", message };
}

export function providerLettaChunk(
  chunk: LettaStreamingResponse,
): ProviderStreamEvent {
  return { type: "letta-chunk", chunk };
}

export interface ProviderStreamAdapter {
  stream(
    input: ProviderTurnInput,
  ):
    | AsyncIterable<ProviderStreamEvent>
    | Promise<AsyncIterable<ProviderStreamEvent>>;
}

class MissingProviderStreamAdapter implements ProviderStreamAdapter {
  async *stream(): AsyncIterable<ProviderStreamEvent> {
    yield {
      type: "error",
      error: new Error(
        "Provider turn adapter is not configured for this dev backend",
      ),
    };
  }
}

function bodyListField(body: HeadlessTurnBody, key: string): unknown[] {
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

export function buildProviderTurnInput(
  input: HeadlessTurnExecutorInput,
): ProviderTurnInput {
  return {
    conversationId: input.conversationId,
    agentId: input.agentId,
    agent: input.agent,
    systemPrompt: input.systemPrompt,
    midConversationSystemPrompt: input.midConversationSystemPrompt,
    body: input.body,
    history: input.history,
    uiMessages: input.uiMessages,
    clientTools: bodyListField(input.body, "client_tools"),
    clientSkills: bodyListField(input.body, "client_skills"),
  };
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input ?? {});
}

function createLocalMessageChunk(
  message: LocalMessage,
): LettaStreamingResponse {
  return markLocalStateChunkOnly(
    attachLocalMessage({ message_type: "local_message" }, message),
  ) as unknown as LettaStreamingResponse;
}

function createProviderErrorChunks(error: unknown): LettaStreamingResponse[] {
  const info = normalizeLocalProviderError(error);
  return [
    {
      message_type: "error_message",
      message: info.message,
      detail: info.detail,
      error_type: info.error_type,
      retryable: info.retryable,
    } as unknown as LettaStreamingResponse,
    {
      message_type: "stop_reason",
      stop_reason: info.stop_reason,
    } as LettaStreamingResponse,
  ];
}

export function contextTokensFromUsage(usage: Usage): number | undefined {
  return contextTokensFromLocalUsage(usage);
}

function estimateSerializedTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    const serialized =
      typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return Math.ceil(serialized.length / 4);
  } catch {
    return 0;
  }
}

export function estimateProviderContextTokens(
  input: ProviderTurnInput,
): number | undefined {
  const contextEstimate = estimateLocalContextTokens(input.uiMessages);
  if (contextEstimate.lastUsageIndex !== null) {
    return contextEstimate.tokens > 0 ? contextEstimate.tokens : undefined;
  }

  const systemPromptTokens = estimateSerializedTokens(
    input.systemPrompt ?? input.agent.system,
  );
  const messageTokens = contextEstimate.tokens;
  const toolTokens = estimateSerializedTokens(input.clientTools);
  const total = systemPromptTokens + messageTokens + toolTokens;
  return total > 0 ? total : undefined;
}

function serializedLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    const serialized =
      typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    return serialized.length;
  } catch {
    return 0;
  }
}

// Approximate request payload size in bytes (serialized chars ~= bytes for the
// dominant base64/ASCII content). This intentionally measures bytes, not
// tokens: image/base64 payloads are cheap in provider tokens but can break
// provider transports when the raw request body grows too large. Slightly
// overcounts versus the real request because local message wrappers
// (ids/timestamps/metadata) are included.
export function estimateProviderRequestBytes(
  input: ProviderTurnInput,
): number | undefined {
  const systemPromptBytes = serializedLength(
    input.systemPrompt ?? input.agent.system,
  );
  const messageBytes = serializedLength(input.uiMessages);
  const toolBytes = serializedLength(input.clientTools);
  const total = systemPromptBytes + messageBytes + toolBytes;
  return total > 0 ? total : undefined;
}

function createUsageStatisticsChunk(
  usage: Usage | undefined,
  contextTokensEstimate?: number,
): LettaStreamingResponse | undefined {
  const promptTokens = usage?.input;
  const completionTokens = usage?.output;
  const totalTokens = usage?.totalTokens;
  const usageContextTokens = usage ? contextTokensFromUsage(usage) : undefined;
  const contextTokens = usageContextTokens ?? contextTokensEstimate;
  const cachedInputTokens = usage?.cacheRead;
  const cacheWriteTokens = usage?.cacheWrite;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheWriteTokens === undefined &&
    contextTokens === undefined
  ) {
    return undefined;
  }
  return {
    message_type: "usage_statistics",
    ...(promptTokens !== undefined ? { prompt_tokens: promptTokens } : {}),
    ...(completionTokens !== undefined
      ? { completion_tokens: completionTokens }
      : {}),
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(cachedInputTokens !== undefined
      ? { cached_input_tokens: cachedInputTokens }
      : {}),
    ...(cacheWriteTokens !== undefined
      ? { cache_write_tokens: cacheWriteTokens }
      : {}),
    ...(contextTokens !== undefined ? { context_tokens: contextTokens } : {}),
  } as unknown as LettaStreamingResponse;
}

function errorFromAssistantEvent(part: AssistantMessageEvent): Error {
  if (part.type !== "error") return new Error("Unknown provider stream error");
  return new Error(part.error.errorMessage ?? "Unknown local provider error");
}

function otidForContentIndex(
  otids: Map<number, string>,
  prefix: string,
  contentIndex: number,
): string {
  const existing = otids.get(contentIndex);
  if (existing) return existing;
  const otid = `${prefix}-${contentIndex}-${randomUUID()}`;
  otids.set(contentIndex, otid);
  return otid;
}

function createProviderLettaStream(
  events: AsyncIterable<ProviderStreamEvent>,
  contextTokensEstimate?: number,
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      let sawToolCall = false;
      let pendingStopReason: LettaStreamingResponse | undefined;
      let sawUsageStatistics = false;
      const assistantOtids = new Map<number, string>();
      const reasoningOtids = new Map<number, string>();
      try {
        for await (const event of events) {
          if (event.type === "error") {
            yield* createProviderErrorChunks(event.error);
            return;
          }

          if (event.type === "local-message") {
            yield createLocalMessageChunk(event.message);
            continue;
          }

          if (event.type === "letta-chunk") {
            yield event.chunk;
            continue;
          }

          const { part } = event;
          if (part.type === "text_delta") {
            yield {
              message_type: "assistant_message",
              otid: otidForContentIndex(
                assistantOtids,
                "provider-assistant",
                part.contentIndex,
              ),
              content: [{ type: "text", text: part.delta }],
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "thinking_delta") {
            yield {
              message_type: "reasoning_message",
              otid: otidForContentIndex(
                reasoningOtids,
                "provider-reasoning",
                part.contentIndex,
              ),
              reasoning: part.delta,
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "toolcall_end") {
            sawToolCall = true;
            yield {
              message_type: "approval_request_message",
              tool_call: {
                tool_call_id: part.toolCall.id,
                name: part.toolCall.name,
                arguments: stringifyToolInput(part.toolCall.arguments),
              },
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "done") {
            if (!sawUsageStatistics) {
              const usageChunk = createUsageStatisticsChunk(
                part.message.usage,
                contextTokensEstimate,
              );
              if (usageChunk) {
                sawUsageStatistics = true;
                yield usageChunk;
              }
            }
            pendingStopReason = {
              message_type: "stop_reason",
              stop_reason:
                sawToolCall || part.reason === "toolUse"
                  ? "requires_approval"
                  : "end_turn",
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "error") {
            yield* createProviderErrorChunks(errorFromAssistantEvent(part));
            return;
          }
        }
        if (pendingStopReason) {
          yield pendingStopReason;
        } else if (sawToolCall) {
          yield {
            message_type: "stop_reason",
            stop_reason: "requires_approval",
          } as LettaStreamingResponse;
        }
      } catch (error) {
        yield* createProviderErrorChunks(error);
      }
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

export class ProviderTurnExecutor implements HeadlessTurnExecutor {
  constructor(
    private readonly adapter: ProviderStreamAdapter = new MissingProviderStreamAdapter(),
  ) {}

  async execute(input: HeadlessTurnExecutorInput) {
    const providerInput = buildProviderTurnInput(input);
    const events = await this.adapter.stream(providerInput);
    return createProviderLettaStream(
      events,
      estimateProviderContextTokens(providerInput),
    );
  }
}
