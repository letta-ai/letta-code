import { describe, expect, test } from "bun:test";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type { SdkClient, SdkStreamMessage, SubagentRequest } from "./types.ts";

const CONFIG: SdkSpawnerConfig = {
  parentAgentId: "agent-parent",
  model: "openai/gpt-5.6-luna",
};

function request(): SubagentRequest {
  return { prompt: "inspect the repository", options: {}, callIndex: 0 };
}

function fakeClient(messages: SdkStreamMessage[]): SdkClient {
  return {
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
}

function usage(totalTokens: number, cost?: number | null): SdkStreamMessage {
  return {
    type: "stream_event",
    event: {
      message_type: "usage_statistics",
      total_tokens: totalTokens,
      ...(cost !== undefined ? { estimated_cost_usd: cost } : {}),
    },
  };
}

const RESULT: SdkStreamMessage = {
  type: "result",
  success: true,
  result: "ok",
};

describe("createSdkSpawner cost reporting", () => {
  test("sums per-step estimated_cost_usd and reports it live", async () => {
    const seen: Array<[number, number | null | undefined]> = [];
    const outcome = await createSdkSpawner(
      fakeClient([usage(1_000, 0.01), usage(2_000, 0.025), RESULT]),
      CONFIG,
    )(request(), new AbortController().signal, {
      onUsage: (tokens, cost) => seen.push([tokens, cost]),
    });
    expect(seen).toEqual([
      [1_000, 0.01],
      [3_000, 0.035],
    ]);
    expect(outcome).toMatchObject({ totalTokens: 3_000, costUsd: 0.035 });
  });

  test("a step without a cost estimate makes the session cost unknown", async () => {
    for (const missing of [null, undefined]) {
      const seen: Array<number | null | undefined> = [];
      const outcome = await createSdkSpawner(
        fakeClient([usage(1_000, 0.01), usage(500, missing), RESULT]),
        CONFIG,
      )(request(), new AbortController().signal, {
        onUsage: (_tokens, cost) => seen.push(cost),
      });
      expect(seen).toEqual([0.01, null]);
      expect(outcome.costUsd).toBeNull();
    }
  });

  test("omits cost when no usage was reported", async () => {
    const outcome = await createSdkSpawner(fakeClient([RESULT]), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome.costUsd).toBeUndefined();
  });
});
