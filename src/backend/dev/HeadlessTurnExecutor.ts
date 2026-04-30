import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  ConversationMessageCreateBody,
  ConversationMessageStreamBody,
} from "../backend";
import type { FakeHeadlessStore, StoredMessage } from "./FakeHeadlessStore";

export type HeadlessTurnBody =
  | ConversationMessageCreateBody
  | ConversationMessageStreamBody;

export interface HeadlessTurnExecutorInput {
  conversationId: string;
  body: HeadlessTurnBody;
  store: FakeHeadlessStore;
}

export interface HeadlessTurnExecutor {
  execute(
    input: HeadlessTurnExecutorInput,
  ): Promise<Stream<LettaStreamingResponse>>;
}

export function createAssistantMessageStream(
  message: Pick<StoredMessage, "id" | "date" | "content">,
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      yield {
        message_type: "assistant_message",
        id: message.id,
        date: message.date,
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
  async execute({ conversationId, body, store }: HeadlessTurnExecutorInput) {
    const assistantMessage = store.appendTurn(conversationId, body);
    return createAssistantMessageStream(assistantMessage);
  }
}
