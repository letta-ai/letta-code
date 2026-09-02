import { describe, expect, test } from "bun:test";
import { SdkSubagentPool } from "./sdk-spawner.ts";
import type {
  SdkClient,
  SdkSession,
  SdkStreamMessage,
  SubagentRequest,
} from "./types.ts";

function request(
  options: SubagentRequest["options"] = {},
  prompt = "hello",
): SubagentRequest {
  return { prompt, options, cacheKey: "k", occurrence: 0, callIndex: 0 };
}

function fakeSession(messages: SdkStreamMessage[]): SdkSession {
  return {
    send: async () => {},
    async *stream() {
      for (const message of messages) yield message;
    },
    abort: async () => {},
    close: () => {},
  };
}

function fakeClient(params: {
  onCreateSession: (options: Record<string, unknown>) => SdkSession;
}): SdkClient & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    createAgent: async () => "agent-worker",
    createSession: (_agentId, options) => params.onCreateSession(options ?? {}),
    agents: {
      delete: async (agentId) => {
        deleted.push(agentId);
      },
    },
  };
}

const RESULT_OK: SdkStreamMessage = {
  type: "result",
  success: true,
  result: "done",
  totalCostUsd: 0.02,
  durationMs: 1200,
};

describe("SdkSubagentPool", () => {
  test("plain calls run as stateless sessions without persisted options", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient({
      onCreateSession: (options) => {
        seen.push(options);
        return fakeSession([RESULT_OK]);
      },
    });
    const pool = new SdkSubagentPool(client);
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome).toMatchObject({ value: "done", failed: false });
    expect(seen[0]).toMatchObject({ stateless: true });
    expect(seen[0]).not.toHaveProperty("model");
    expect(seen[0]).not.toHaveProperty("reasoningEffort");
  });

  test("model or effort overrides run on a fresh regular session", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = fakeClient({
      onCreateSession: (options) => {
        seen.push(options);
        return fakeSession([RESULT_OK]);
      },
    });
    const pool = new SdkSubagentPool(client);
    await pool.spawner(
      request({ effort: "low" }),
      new AbortController().signal,
    );
    await pool.spawner(
      request({ model: "openai/gpt-5.5" }),
      new AbortController().signal,
    );
    expect(seen[0]).toMatchObject({ stateless: false, reasoningEffort: "low" });
    expect(seen[1]).toMatchObject({
      stateless: false,
      model: "openai/gpt-5.5",
    });
  });

  test("session option validation errors become failed outcomes", async () => {
    const client = fakeClient({
      onCreateSession: () => {
        throw new Error("stateless sessions cannot set reasoningEffort");
      },
    });
    const pool = new SdkSubagentPool(client);
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeNull();
    expect(outcome.error).toContain("reasoningEffort");
  });

  test("sums usage_statistics stream events into totalTokens", async () => {
    const client = fakeClient({
      onCreateSession: () =>
        fakeSession([
          {
            type: "stream_event",
            event: { message_type: "usage_statistics", total_tokens: 1500 },
          },
          { type: "assistant", content: "partial" },
          {
            type: "stream_event",
            event: { message_type: "usage_statistics", total_tokens: 2500 },
          },
          { type: "stream_event", event: { message_type: "stop_reason" } },
          RESULT_OK,
        ]),
    });
    const pool = new SdkSubagentPool(client);
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome).toMatchObject({
      value: "done",
      totalTokens: 4000,
      costUsd: 0.02,
      durationMs: 1200,
    });
  });

  test("cleanup deletes the shared worker agent once", async () => {
    const client = fakeClient({
      onCreateSession: () => fakeSession([RESULT_OK]),
    });
    const pool = new SdkSubagentPool(client);
    await pool.spawner(request(), new AbortController().signal);
    await pool.cleanup();
    await pool.cleanup();
    expect(client.deleted).toEqual(["agent-worker"]);
  });
});
