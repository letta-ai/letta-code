import { randomUUID } from "node:crypto";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StoredMessage } from "./FakeHeadlessStore";
import type {
  HeadlessTurnBody,
  HeadlessTurnExecutor,
  HeadlessTurnExecutorInput,
} from "./HeadlessTurnExecutor";
import {
  type ProviderTrajectoryMessage,
  type ProviderTrajectoryUIMessage,
  providerUIMessages,
} from "./ProviderTrajectory";

export interface ProviderTurnInput {
  conversationId: string;
  agentId: string;
  body: HeadlessTurnBody;
  history: StoredMessage[];
  providerTrajectory: ProviderTrajectoryMessage[];
  uiMessages: ProviderTrajectoryUIMessage[];
  clientTools: unknown[];
  clientSkills: unknown[];
}

export type ProviderStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "finish"; finishReason?: string }
  | { type: "error"; error: unknown };

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
    body: input.body,
    history: input.history,
    providerTrajectory: input.providerTrajectory,
    uiMessages: providerUIMessages(input.providerTrajectory),
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

function createProviderLettaStream(
  events: AsyncIterable<ProviderStreamEvent>,
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      let sawToolCall = false;
      const assistantOtid = `provider-assistant-${randomUUID()}`;
      try {
        for await (const event of events) {
          if (event.type === "text-delta") {
            yield {
              message_type: "assistant_message",
              otid: assistantOtid,
              content: [{ type: "text", text: event.text }],
            } as LettaStreamingResponse;
            continue;
          }

          if (event.type === "reasoning-delta") {
            yield {
              message_type: "assistant_message",
              otid: assistantOtid,
              content: [{ type: "reasoning", text: event.text }],
            } as unknown as LettaStreamingResponse;
            continue;
          }

          if (event.type === "tool-call") {
            sawToolCall = true;
            yield {
              message_type: "approval_request_message",
              tool_call: {
                tool_call_id: event.toolCallId,
                name: event.toolName,
                arguments: stringifyToolInput(event.input),
              },
            } as LettaStreamingResponse;
            continue;
          }

          if (event.type === "finish") {
            yield {
              message_type: "stop_reason",
              stop_reason:
                sawToolCall || event.finishReason === "tool-calls"
                  ? "requires_approval"
                  : "end_turn",
            } as LettaStreamingResponse;
            continue;
          }

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
