import { randomUUID } from "node:crypto";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { LocalMessage } from "../local/LocalMessage";
import type { LocalAgentRecord, StoredMessage } from "../local/LocalStore";
import {
  attachLocalUIMessage,
  markLocalStateChunkOnly,
  type ProviderStreamPart,
} from "../local/LocalStreamChunks";
import type {
  HeadlessTurnBody,
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "./HeadlessTurnExecutor";

export interface ProviderTurnInput {
  conversationId: string;
  agentId: string;
  agent: LocalAgentRecord;
  systemPrompt?: string;
  body: HeadlessTurnBody;
  history: StoredMessage[];
  uiMessages: LocalMessage[];
  clientTools: unknown[];
  clientSkills: unknown[];
}

export type ProviderStreamEvent =
  | { type: "ai-sdk-part"; part: ProviderStreamPart }
  | { type: "ai-sdk-ui-message"; message: LocalMessage }
  | { type: "error"; error: unknown };

export function providerStreamPart(
  part: ProviderStreamPart,
): ProviderStreamEvent {
  return { type: "ai-sdk-part", part };
}

export function providerUIMessage(message: LocalMessage): ProviderStreamEvent {
  return { type: "ai-sdk-ui-message", message };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createLocalUIMessageChunk(
  message: LocalMessage,
): LettaStreamingResponse {
  return markLocalStateChunkOnly(
    attachLocalUIMessage({ message_type: "local_ui_message" }, message),
  ) as unknown as LettaStreamingResponse;
}

function createProviderLettaStream(
  events: AsyncIterable<ProviderStreamEvent>,
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      let sawToolCall = false;
      let pendingStopReason: LettaStreamingResponse | undefined;
      const assistantOtid = `provider-assistant-${randomUUID()}`;
      const reasoningOtid = `provider-reasoning-${randomUUID()}`;
      try {
        for await (const event of events) {
          if (event.type === "error") {
            yield {
              message_type: "error_message",
              message: errorMessage(event.error),
            } as LettaStreamingResponse;
            yield {
              message_type: "stop_reason",
              stop_reason: "error",
            } as LettaStreamingResponse;
            return;
          }

          if (event.type === "ai-sdk-ui-message") {
            yield createLocalUIMessageChunk(event.message);
            continue;
          }

          const { part } = event;
          if (part.type === "text-delta") {
            yield {
              message_type: "assistant_message",
              otid: assistantOtid,
              content: [{ type: "text", text: part.text }],
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "reasoning-delta") {
            yield {
              message_type: "reasoning_message",
              otid: reasoningOtid,
              reasoning: part.text,
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "tool-call") {
            sawToolCall = true;
            yield {
              message_type: "approval_request_message",
              tool_call: {
                tool_call_id: part.toolCallId,
                name: part.toolName,
                arguments: stringifyToolInput(part.input),
              },
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "finish") {
            pendingStopReason = {
              message_type: "stop_reason",
              stop_reason:
                sawToolCall || part.finishReason === "tool-calls"
                  ? "requires_approval"
                  : "end_turn",
            } as LettaStreamingResponse;
            continue;
          }

          if (part.type === "error") {
            yield {
              message_type: "error_message",
              message: errorMessage(part.error),
            } as LettaStreamingResponse;
            yield {
              message_type: "stop_reason",
              stop_reason: "error",
            } as LettaStreamingResponse;
            return;
          }
        }
        if (pendingStopReason) {
          yield pendingStopReason;
        }
      } catch (error) {
        yield {
          message_type: "error_message",
          message: errorMessage(error),
        } as LettaStreamingResponse;
        yield {
          message_type: "stop_reason",
          stop_reason: "error",
        } as LettaStreamingResponse;
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
    return createProviderLettaStream(events);
  }
}
