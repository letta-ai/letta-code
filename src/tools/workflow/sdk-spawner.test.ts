import { describe, expect, test } from "bun:test";
import { MAX_SUBAGENT_TOOL_CALLS, SdkSubagentPool } from "./sdk-spawner.ts";
import type {
  SdkClient,
  SdkQuery,
  SdkStreamMessage,
  SubagentRequest,
} from "./types.ts";

function request(options: SubagentRequest["options"] = {}): SubagentRequest {
  return {
    prompt: "inspect the repository",
    options,
    cacheKey: "cache-key",
    occurrence: 0,
    callIndex: 0,
  };
}

function completedQuery(messages: SdkStreamMessage[]): SdkQuery {
  return {
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    async interrupt() {},
    close() {},
  };
}

describe("SdkSubagentPool", () => {
  test("runs each call as an agent-free query with isolated model settings", async () => {
    const calls: Array<{
      prompt: string;
      options: Record<string, unknown>;
    }> = [];
    const client: SdkClient = {
      query(params) {
        calls.push(params);
        return completedQuery([
          { type: "assistant", content: "done" },
          { type: "result", success: true, result: "done" },
        ]);
      },
    };
    const pool = new SdkSubagentPool(client, {
      cwd: "/repo",
      model: "openai/gpt-5.6-luna",
    });

    const outcome = await pool.spawner(
      request({ effort: "high", systemPrompt: "Focus on runtime behavior." }),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({ value: "done", failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      prompt: "inspect the repository",
      options: {
        model: "openai/gpt-5.6-luna",
        modelSettings: { reasoning_effort: "high" },
        cwd: "/repo",
        permissionMode: "unrestricted",
        allowedTools: ["Read", "Grep", "Glob"],
        skillSources: [],
      },
    });
    expect(String(calls[0]?.options.system)).toContain(
      "Focus on runtime behavior.",
    );
  });

  test("sums usage statistics from an agent-free query", async () => {
    const client: SdkClient = {
      query() {
        return completedQuery([
          {
            type: "stream_event",
            event: { message_type: "usage_statistics", total_tokens: 1500 },
          },
          {
            type: "stream_event",
            event: { message_type: "usage_statistics", total_tokens: 2500 },
          },
          {
            type: "result",
            success: true,
            result: "done",
            totalCostUsd: 0.02,
            durationMs: 1200,
          },
        ]);
      },
    };
    const pool = new SdkSubagentPool(client, {
      model: "openai/gpt-5.6-luna",
    });

    const outcome = await pool.spawner(request(), new AbortController().signal);

    expect(outcome).toMatchObject({
      value: "done",
      totalTokens: 4000,
      costUsd: 0.02,
      durationMs: 1200,
    });
  });

  test("captures StructuredOutput from a query-scoped custom tool", async () => {
    const client: SdkClient = {
      query(params) {
        const tools = params.options.tools as Array<{
          execute(toolCallId: string, args: unknown): Promise<unknown>;
        }>;
        return {
          async *[Symbol.asyncIterator]() {
            await tools[0]?.execute("call-1", { answer: 42 });
            yield { type: "result", success: true };
          },
          async interrupt() {},
          close() {},
        };
      },
    };
    const pool = new SdkSubagentPool(client, {
      model: "openai/gpt-5.6-luna",
    });

    const outcome = await pool.spawner(
      request({
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      }),
      new AbortController().signal,
    );

    expect(outcome).toMatchObject({
      value: { answer: 42 },
      failed: false,
    });
  });

  test("settles locally when a query exceeds its timeout", async () => {
    let interrupted = 0;
    let closed = 0;
    const client: SdkClient = {
      query() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<SdkStreamMessage>>(() => {}),
            };
          },
          async interrupt() {
            interrupted += 1;
          },
          close() {
            closed += 1;
          },
        };
      },
    };
    const pool = new SdkSubagentPool(client, {
      model: "openai/gpt-5.6-luna",
    });

    const outcome = await pool.spawner(
      request({ timeoutMs: 10 }),
      new AbortController().signal,
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain("timed out after 10ms");
    expect(interrupted).toBe(1);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  test("disposes SDK-owned resources without creating a worker agent", async () => {
    let disposed = false;
    const client: SdkClient = {
      query() {
        return completedQuery([]);
      },
      async [Symbol.asyncDispose]() {
        disposed = true;
      },
    };
    const pool = new SdkSubagentPool(client);

    await pool.cleanup();

    expect(disposed).toBe(true);
  });
});

describe("SdkSubagentPool structured output loop guard", () => {
  test("ends the query once StructuredOutput captures a valid value", async () => {
    let interrupted = 0;
    let closed = 0;
    const client: SdkClient = {
      query(params) {
        const tools = params.options.tools as Array<{
          execute: (id: string, args: unknown) => Promise<unknown>;
        }>;
        const tool = tools[0];
        if (!tool) throw new Error("StructuredOutput tool missing");
        let release: (() => void) | null = null;
        const stalled = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "stream_event",
              event: { message_type: "usage_statistics", total_tokens: 900 },
            } as SdkStreamMessage;
            // The model calls the tool; a looping model would now call it
            // again forever. The stream never ends on its own.
            await tool.execute("call-1", { answer: 42 });
            await stalled;
          },
          async interrupt() {
            interrupted += 1;
            release?.();
          },
          close() {
            closed += 1;
            release?.();
          },
        };
      },
    };
    const pool = new SdkSubagentPool(client, { model: "openai/gpt-5.6-luna" });
    const outcome = await pool.spawner(
      request({
        schema: {
          type: "object",
          properties: { answer: { type: "number" } },
          required: ["answer"],
        },
      }),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      value: { answer: 42 },
      failed: false,
      totalTokens: 900,
    });
    expect(interrupted).toBe(1);
    expect(closed).toBeGreaterThan(0);
  });
});

describe("SdkSubagentPool runaway guards", () => {
  function loopingClient(makeMessages: () => SdkStreamMessage[]): {
    client: SdkClient;
    stats: { interrupted: number };
  } {
    const stats = { interrupted: 0 };
    const client: SdkClient = {
      query() {
        let release: (() => void) | null = null;
        const stalled = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          async *[Symbol.asyncIterator]() {
            for (const message of makeMessages()) yield message;
            await stalled;
          },
          async interrupt() {
            stats.interrupted += 1;
            release?.();
          },
          close() {
            release?.();
          },
        };
      },
    };
    return { client, stats };
  }

  /** One tool call as the SDK streams it: argument deltas, then the result. */
  function toolCall(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): SdkStreamMessage[] {
    return [
      { type: "tool_call", toolCallId: id, toolName: name, toolInput: {} },
      { type: "tool_call", toolCallId: id, toolName: name, toolInput: input },
      { type: "tool_result", toolCallId: id, content: "ok" },
      // The server's tool return echoes the same call; it must not count.
      { type: "tool_result", toolCallId: id, content: "ok" },
    ];
  }

  test("stops a subagent that repeats the identical tool call", async () => {
    const { client, stats } = loopingClient(() =>
      ["c1", "c2", "c3", "c4"].flatMap((id) =>
        toolCall(id, "Grep", { pattern: "import" }),
      ),
    );
    const pool = new SdkSubagentPool(client, { model: "openai/gpt-5.6-luna" });
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain("identical Grep call 3 times");
    expect(stats.interrupted).toBe(1);
  });

  test("stops a subagent that exceeds the tool-call cap", async () => {
    const { client, stats } = loopingClient(() =>
      Array.from({ length: MAX_SUBAGENT_TOOL_CALLS + 1 }, (_, i) =>
        toolCall(`call-${i}`, "Read", { file_path: `f${i}` }),
      ).flat(),
    );
    const pool = new SdkSubagentPool(client, { model: "openai/gpt-5.6-luna" });
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain(
      `exceeded ${MAX_SUBAGENT_TOOL_CALLS} tool calls`,
    );
    expect(stats.interrupted).toBe(1);
  });

  test("two identical calls are tolerated; the third is not", async () => {
    const client: SdkClient = {
      query() {
        return completedQuery([
          ...toolCall("1", "Read", { file_path: "a" }),
          ...toolCall("2", "Read", { file_path: "a" }),
          { type: "result", success: true, result: "done" },
        ]);
      },
    };
    const pool = new SdkSubagentPool(client, { model: "openai/gpt-5.6-luna" });
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("distinct calls and argument-delta chunks are not flagged", async () => {
    const client: SdkClient = {
      query() {
        return completedQuery([
          ...toolCall("1", "Read", { file_path: "a" }),
          ...toolCall("2", "Read", { file_path: "b" }),
          ...toolCall("3", "Read", { file_path: "a" }),
          // Many delta chunks of one call count as one call.
          ...Array.from({ length: MAX_SUBAGENT_TOOL_CALLS * 2 }, () => ({
            type: "tool_call",
            toolCallId: "4",
            toolName: "Read",
            toolInput: { file_path: "c" },
          })),
          { type: "tool_result", toolCallId: "4", content: "ok" },
          { type: "result", success: true, result: "done" },
        ]);
      },
    };
    const pool = new SdkSubagentPool(client, { model: "openai/gpt-5.6-luna" });
    const outcome = await pool.spawner(request(), new AbortController().signal);
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });
});
