import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { MessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { Backend } from "@/backend";
import { sendMessageStreamWithBackend } from "./message";

describe("sendMessageStream skill sources", () => {
  test("sends no client skills when the runtime override is empty", async () => {
    let recordedBody: MessageCreateParams | undefined;
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: MessageCreateParams,
      ) => {
        recordedBody = body;
        return stream;
      },
    } as unknown as Backend;

    await sendMessageStreamWithBackend(
      backend,
      "conv-no-skills",
      [{ role: "user", content: "Reflect on this trajectory." }],
      {
        streamTokens: true,
        background: true,
        skillSources: [],
        preparedToolContext: {
          contextId: "ctx-no-skills",
          clientTools: [],
          loadedToolNames: [],
        },
      },
    );

    expect(recordedBody?.client_skills).toEqual([]);
  });
});
