import { describe, expect, test } from "bun:test";
import { createSdkSpawner, type SdkSpawnerConfig } from "./sdk-spawner";
import type {
  SdkClient,
  SdkQuery,
  SdkStreamMessage,
  SubagentRequest,
} from "./types.ts";

const CONFIG: SdkSpawnerConfig = {
  parentAgentId: "agent-parent",
  model: "anthropic/claude-sonnet-4-5",
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
      prompt_tokens: cost == null ? undefined : cost / 0.000003,
      completion_tokens: 0,
      cost_usd: 99,
    },
  };
}

const RESULT: SdkStreamMessage = {
  type: "result",
  success: true,
  result: "ok",
};

describe("createSdkSpawner cost reporting", () => {
  test("sums client-priced api_cost_usd and reports it live", async () => {
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

  test("a stop during a model request interrupts only after its usage arrives", async () => {
    const controller = new AbortController();
    let interrupted = false;
    let interruptedBeforeUsage: boolean | undefined;
    const client: SdkClient = {
      query: () => ({
        conversationId: "conv-worker",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          yield { type: "loop_status", status: "PROCESSING_API_RESPONSE" };
          controller.abort();
          // The request already in flight finishes and bills after the stop.
          await new Promise((resolve) => setTimeout(resolve, 20));
          interruptedBeforeUsage = interrupted;
          yield usage(2_000, 0.02);
          while (!interrupted) await new Promise((r) => setTimeout(r, 1));
          yield { type: "loop_status", status: "WAITING_ON_INPUT" };
          yield { type: "result", success: false, error: "interrupted" };
        },
        async interrupt() {
          interrupted = true;
        },
        close() {},
      }),
    };
    const seen: Array<number | null | undefined> = [];
    const outcome = await createSdkSpawner(client, CONFIG)(
      request(),
      controller.signal,
      { onUsage: (_tokens, cost) => seen.push(cost) },
    );
    expect(interruptedBeforeUsage).toBe(false);
    expect(interrupted).toBe(true);
    expect(seen).toEqual([0.02]);
    expect(outcome).toMatchObject({
      failed: true,
      error: "Workflow subagent interrupted",
      totalTokens: 2_000,
      costUsd: 0.02,
    });
  });

  test("a stop between model requests interrupts immediately", async () => {
    const controller = new AbortController();
    let interrupted = false;
    let interruptedAtStop: boolean | undefined;
    const client: SdkClient = {
      query: () => ({
        conversationId: "conv-worker",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          yield { type: "loop_status", status: "PROCESSING_API_RESPONSE" };
          yield usage(1_000, 0.01);
          yield { type: "loop_status", status: "EXECUTING_CLIENT_SIDE_TOOL" };
          controller.abort();
          interruptedAtStop = interrupted;
          yield { type: "result", success: false, error: "interrupted" };
        },
        async interrupt() {
          interrupted = true;
        },
        close() {},
      }),
    };
    const outcome = await createSdkSpawner(client, CONFIG)(
      request(),
      controller.signal,
    );
    expect(interruptedAtStop).toBe(true);
    expect(outcome).toMatchObject({ failed: true, costUsd: 0.01 });
  });

  test("a model request that never reports usage settles after the drain window", async () => {
    const controller = new AbortController();
    let interrupted = false;
    let closed = false;
    const client: SdkClient = {
      query: () => ({
        conversationId: "conv-worker",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          yield usage(1_000, 0.01);
          yield { type: "loop_status", status: "WAITING_FOR_API_RESPONSE" };
          controller.abort();
          await new Promise(() => {});
        },
        async interrupt() {
          interrupted = true;
        },
        close() {
          closed = true;
        },
      }),
    };
    const outcome = await createSdkSpawner(client, {
      ...CONFIG,
      stopDrainMs: 20,
    })(request(), controller.signal);
    expect(interrupted).toBe(true);
    expect(closed).toBe(true);
    expect(outcome).toMatchObject({
      failed: true,
      error: "Workflow subagent interrupted",
      costUsd: 0.01,
    });
  });

  test("ignores usage arriving after an interrupted agent's drain window", async () => {
    let releaseLate!: () => void;
    const late = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    let firstUsage!: () => void;
    const first = new Promise<void>((resolve) => {
      firstUsage = resolve;
    });
    let drained!: () => void;
    const drainFinished = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const usage = (tokens: number): SdkStreamMessage => ({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: tokens },
    });
    const query: SdkQuery = {
      conversationId: "conv-worker",
      agentId: null,
      async *[Symbol.asyncIterator]() {
        yield usage(100);
        await late;
        yield usage(200);
        drained();
      },
      async interrupt() {},
      close() {},
    };
    const controller = new AbortController();
    const seen: number[] = [];
    const pending = createSdkSpawner(
      { query: () => query },
      {
        ...CONFIG,
        stopDrainMs: 20,
      },
    )(request(), controller.signal, {
      onUsage(tokens) {
        seen.push(tokens);
        firstUsage();
      },
    });
    await first;
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ failed: true, totalTokens: 100 });
    releaseLate();
    await drainFinished;
    expect(seen).toEqual([100]);
  });
});
