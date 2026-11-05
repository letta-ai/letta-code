import { expect, test } from "bun:test";
import { createSdkSpawner } from "./sdk-spawner";
import type { SdkClient, SdkStreamMessage } from "./types";

test("prices raw SDK usage before workflow consumers read it", async () => {
  const messages: SdkStreamMessage[] = [
    {
      type: "stream_event",
      event: {
        message_type: "usage_statistics",
        prompt_tokens: 1000,
        completion_tokens: 100,
        cost_usd: 99,
      },
    },
    { type: "result", success: true, result: "ok" },
  ];
  const client: SdkClient = {
    query: () => ({
      conversationId: "conv-worker",
      agentId: null,
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      async interrupt() {},
      close() {},
    }),
  };
  await createSdkSpawner(client, {
    parentAgentId: "agent-parent",
    model: "anthropic/claude-sonnet-4-5",
  })(
    { prompt: "inspect", options: {}, callIndex: 0 },
    new AbortController().signal,
  );
  expect(messages[0]?.event?.cost_usd).toBeCloseTo(0.0045);
});
