import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
} from "../backend";
import type { StoredMessage } from "./FakeHeadlessStore";

export type HeadlessTurnBody =
  | ConversationMessageCreateBody
  | ConversationMessageStreamBody;

export interface HeadlessTurnExecutorInput {
  conversationId: string;
  agentId: string;
  body: HeadlessTurnBody;
}

export interface HeadlessTurnExecutor {
  execute(
    input: HeadlessTurnExecutorInput,
  ): Promise<Stream<LettaStreamingResponse>>;
}

export function createAssistantMessageStream(
  message: Partial<Pick<StoredMessage, "id" | "date" | "content">> = {},
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "assistant_message",
        ...(message.id ? { id: message.id } : {}),
        ...(message.date ? { date: message.date } : {}),
        content: message.content ?? [{ type: "text", text: "pong" }],
      } as LettaStreamingResponse;
      yield {
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as LettaStreamingResponse;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

export class DeterministicPongExecutor implements HeadlessTurnExecutor {
  async execute(_input: HeadlessTurnExecutorInput) {
    return createAssistantMessageStream();
  }
}
