import { describe, expect, test } from "bun:test";
import {
  createSdkSpawner,
  DEFAULT_ALLOWED_TOOLS,
  MAX_SUBAGENT_TOOL_CALLS,
  parseJsonReply,
  type SdkSpawnerConfig,
} from "./sdk-spawner.ts";
import type {
  SdkClient,
  SdkQuery,
  SdkStreamMessage,
  SubagentRequest,
} from "./types.ts";

const CONFIG: SdkSpawnerConfig = {
  parentAgentId: "agent-parent",
  model: "openai/gpt-5.6-luna",
  resolveModel: (id) => (id === "sonnet" ? "anthropic/claude-sonnet-5" : null),
};

function request(options: SubagentRequest["options"] = {}): SubagentRequest {
  return { prompt: "inspect the repository", options, callIndex: 0 };
}

function completedQuery(
  messages: SdkStreamMessage[],
  conversationId = "conv-worker",
): SdkQuery {
  return {
    conversationId,
    agentId: null,
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
    async interrupt() {},
    close() {},
  };
}

/** A client that records query options and answers with `messages`. */
function fakeClient(messages: SdkStreamMessage[]): SdkClient & {
  calls: Array<{ prompt: string; options: Record<string, unknown> }>;
} {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  return {
    calls,
    query(params) {
      calls.push(params);
      return completedQuery(messages);
    },
  };
}

describe("parseJsonReply", () => {
  test("accepts bare JSON and a fenced block, rejects prose", () => {
    expect(parseJsonReply(' {"a":1}\n')).toEqual({ a: 1 });
    expect(parseJsonReply('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
    expect(parseJsonReply("```\n[1]\n```")).toEqual([1]);
    expect(() => parseJsonReply('Here: {"a":1}')).toThrow();
  });
});

describe("createSdkSpawner", () => {
  test("passes parent lineage, defaults, and per-call options to query()", async () => {
    const client = fakeClient([
      { type: "result", success: true, result: "done" },
    ]);
    const outcome = await createSdkSpawner(client, {
      ...CONFIG,
      cwd: "/repo",
    })(
      request({
        label: "review:a",
        effort: "low",
        allowedTools: ["Read"],
        systemPrompt: "Only look at src/.",
      }),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({
      value: "done",
      failed: false,
      conversationId: "conv-worker",
    });
    expect(client.calls[0]?.prompt).toBe("inspect the repository");
    expect(client.calls[0]?.options).toMatchObject({
      model: "openai/gpt-5.6-luna",
      parentAgentId: "agent-parent",
      isSubagent: true,
      name: "review:a",
      permissionMode: "unrestricted",
      allowedTools: ["Read"],
      skillSources: [],
      cwd: "/repo",
      modelSettings: { reasoning_effort: "low" },
    });
    expect(String(client.calls[0]?.options.system)).toContain(
      "Only look at src/.",
    );
  });

  test("defaults to read-only tools and a numbered worker name", async () => {
    const client = fakeClient([{ type: "result", success: true, result: "" }]);
    await createSdkSpawner(client, CONFIG)(
      { ...request(), callIndex: 4 },
      new AbortController().signal,
    );
    expect(client.calls[0]?.options).toMatchObject({
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      name: "Workflow worker 5",
    });
  });

  test("resolves per-call model aliases and fails unknown ones before querying", async () => {
    const client = fakeClient([{ type: "result", success: true, result: "" }]);
    const spawner = createSdkSpawner(client, CONFIG);
    await spawner(request({ model: "sonnet" }), new AbortController().signal);
    expect(client.calls[0]?.options.model).toBe("anthropic/claude-sonnet-5");
    const unknown = await spawner(
      request({ model: "nope" }),
      new AbortController().signal,
    );
    expect(unknown.failed).toBe(true);
    expect(unknown.error).toContain("letta model list");
    expect(client.calls).toHaveLength(1);
  });

  test("json option parses the reply and fails on non-JSON", async () => {
    const good = await createSdkSpawner(
      fakeClient([{ type: "result", success: true, result: '{"n": 1}' }]),
      CONFIG,
    )(request({ json: true }), new AbortController().signal);
    expect(good).toMatchObject({ value: { n: 1 }, failed: false });
    const bad = await createSdkSpawner(
      fakeClient([{ type: "result", success: true, result: "not json" }]),
      CONFIG,
    )(request({ json: true }), new AbortController().signal);
    expect(bad).toMatchObject({ value: null, failed: true });
    expect(bad.error).toContain("not valid JSON");
  });

  test("sums usage_statistics stream events into totalTokens, even on an early stop", async () => {
    const usage = (total: number) => ({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: total },
    });
    const done = await createSdkSpawner(
      fakeClient([
        usage(1_000),
        { type: "stream_event", event: { message_type: "reasoning" } },
        usage(2_500),
        { type: "result", success: true, result: "ok" },
      ]),
      CONFIG,
    )(request(), new AbortController().signal);
    expect(done).toMatchObject({ value: "ok", totalTokens: 3_500 });

    const repeated: SdkStreamMessage[] = [usage(700)];
    for (let i = 0; i < 3; i++) {
      repeated.push(
        {
          type: "tool_call",
          toolCallId: `c${i}`,
          toolName: "Read",
          toolInput: {},
        },
        { type: "tool_result", toolCallId: `c${i}` },
      );
    }
    const stopped = await createSdkSpawner(fakeClient(repeated), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(stopped.failed).toBe(true);
    expect(stopped.totalTokens).toBe(700);
  });

  test("falls back to streamed assistant text and reports turn failures", async () => {
    const text = await createSdkSpawner(
      fakeClient([
        { type: "assistant", content: "partial " },
        { type: "assistant", content: "answer" },
        { type: "result", success: true },
      ]),
      CONFIG,
    )(request(), new AbortController().signal);
    expect(text.value).toBe("partial answer");
    const failed = await createSdkSpawner(
      fakeClient([
        { type: "result", success: false, errorCode: "model_error" },
      ]),
      CONFIG,
    )(request(), new AbortController().signal);
    expect(failed).toMatchObject({ failed: true, error: "model_error" });
  });

  test("stops a subagent that repeats the identical tool call", async () => {
    let interrupted = 0;
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 3; i++) {
      messages.push(
        {
          type: "tool_call",
          toolCallId: `c${i}`,
          toolName: "Read",
          toolInput: { p: "a" },
        },
        { type: "tool_result", toolCallId: `c${i}` },
      );
    }
    messages.push({ type: "result", success: true, result: "late" });
    const client: SdkClient = {
      query: () => ({
        conversationId: "conv-loop",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            await Bun.sleep(1);
            yield message;
          }
        },
        async interrupt() {
          interrupted++;
        },
        close() {},
      }),
    };
    const outcome = await createSdkSpawner(client, CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain("identical Read call 3 times");
    expect(interrupted).toBe(1);
  });

  test("stops a subagent that exceeds the tool-call budget", async () => {
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i <= MAX_SUBAGENT_TOOL_CALLS; i++) {
      messages.push({
        type: "tool_call",
        toolCallId: `c${i}`,
        toolName: "Grep",
        toolInput: { q: i },
      });
    }
    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome.error).toContain(
      `exceeded ${MAX_SUBAGENT_TOOL_CALLS} tool calls`,
    );
  });

  test("times out and honors abort while streaming", async () => {
    let closed = 0;
    const hanging = (): SdkClient => ({
      query: () => ({
        conversationId: "conv-hang",
        agentId: null,
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
        async interrupt() {},
        close() {
          closed++;
        },
      }),
    });
    const timedOut = await createSdkSpawner(hanging(), CONFIG)(
      request({ timeoutMs: 20 }),
      new AbortController().signal,
    );
    expect(timedOut.error).toContain("timed out after 20ms");
    expect(closed).toBeGreaterThan(0);

    const controller = new AbortController();
    const pending = createSdkSpawner(hanging(), CONFIG)(
      request(),
      controller.signal,
    );
    controller.abort();
    expect((await pending).error).toBe("Workflow subagent interrupted");
  });

  test("does not query when already aborted", async () => {
    const client = fakeClient([{ type: "result", success: true, result: "x" }]);
    const controller = new AbortController();
    controller.abort();
    const outcome = await createSdkSpawner(client, CONFIG)(
      request(),
      controller.signal,
    );
    expect(outcome.failed).toBe(true);
    expect(client.calls).toHaveLength(0);
  });
});
