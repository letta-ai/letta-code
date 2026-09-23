import { describe, expect, test } from "bun:test";
import {
  createSdkSpawner,
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_MAX_SUBAGENT_TOOL_CALLS,
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

/**
 * Mirror the SDK's `toolInputFromArguments()`: a fragment that is already an
 * object (or parses as one) passes through, otherwise the raw fragment is
 * wrapped as `{ raw }`. This is the partial `toolInput` the guard sees on every
 * streamed `tool_call` message.
 */
function partialToolInput(fragment: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fragment);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return { raw: fragment };
}

/**
 * Replay the real streamed shape: the SDK emits one `tool_call` message per
 * argument fragment (see `transformStreamDelta`), each carrying a *partial*
 * `toolInput` plus the raw fragment. Concatenating the raw fragments yields the
 * complete argument JSON.
 */
function streamedToolCall(
  id: string,
  name: string,
  argsJson: string,
  fragmentSize = 12,
): SdkStreamMessage[] {
  const fragments: string[] = [];
  for (let i = 0; i < argsJson.length; i += fragmentSize) {
    fragments.push(argsJson.slice(i, i + fragmentSize));
  }
  if (fragments.length === 0) fragments.push(argsJson);
  return fragments.map((fragment) => ({
    type: "tool_call",
    toolCallId: id,
    toolName: name,
    toolInput: partialToolInput(fragment),
    rawArguments: fragment,
  }));
}

function bashArgs(issue: number): string {
  return JSON.stringify({
    command: `gh issue view ${issue} --repo letta-ai/letta-code --json number,title,body`,
    description: `View issue ${issue}`,
  });
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

  test("reports cumulative usage live through the onUsage hook", async () => {
    const usage = (total: number) => ({
      type: "stream_event",
      event: { message_type: "usage_statistics", total_tokens: total },
    });
    const seen: number[] = [];
    const outcome = await createSdkSpawner(
      fakeClient([
        usage(1_000),
        usage(2_500),
        { type: "result", success: true, result: "ok" },
      ]),
      CONFIG,
    )(request(), new AbortController().signal, {
      onUsage: (total) => seen.push(total),
    });
    expect(seen).toEqual([1_000, 3_500]);
    expect(outcome.totalTokens).toBe(3_500);
  });

  test("ignores usage arriving after an interrupted agent has settled", async () => {
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
    const pending = createSdkSpawner({ query: () => query }, CONFIG)(
      request(),
      controller.signal,
      {
        onUsage(tokens) {
          seen.push(tokens);
          firstUsage();
        },
      },
    );
    await first;
    controller.abort();
    const outcome = await pending;
    expect(outcome).toMatchObject({ failed: true, totalTokens: 100 });
    releaseLate();
    await drainFinished;
    expect(seen).toEqual([100]);
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

  test("defaults above 60 tool calls and enforces the custom boundary", async () => {
    const calls = (count: number): SdkStreamMessage[] =>
      Array.from({ length: count }, (_, i) => ({
        type: "tool_call",
        toolCallId: `c${i}`,
        toolName: "Grep",
        toolInput: { q: i },
      }));

    const defaultOutcome = await createSdkSpawner(
      fakeClient([
        ...calls(61),
        { type: "result", success: true, result: "done" },
      ]),
      CONFIG,
    )(request(), new AbortController().signal);
    expect(DEFAULT_MAX_SUBAGENT_TOOL_CALLS).toBe(1000);
    expect(defaultOutcome).toMatchObject({ value: "done", failed: false });

    const atBoundary = await createSdkSpawner(
      fakeClient([
        ...calls(2),
        { type: "result", success: true, result: "done" },
      ]),
      CONFIG,
    )(request({ maxToolCalls: 2 }), new AbortController().signal);
    expect(atBoundary).toMatchObject({ value: "done", failed: false });

    const overBoundary = await createSdkSpawner(fakeClient(calls(3)), CONFIG)(
      request({ maxToolCalls: 2 }),
      new AbortController().signal,
    );
    expect(overBoundary.error).toContain("exceeded 2 tool calls");
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

  test("does not stop distinct commands streamed as argument fragments", async () => {
    // Regression: the SDK streams one `tool_call` message per argument delta,
    // each carrying a PARTIAL `toolInput`. Reading that partial as the call's
    // identity collapsed every distinct command onto the same key and tripped
    // the identical-call guard on the third call.
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `call_${i}`;
      messages.push(...streamedToolCall(id, "Bash", bashArgs(4400 + i)));
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "done" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("does not treat a valid interior JSON delta as the complete arguments", async () => {
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `call_${i}`;
      const fragments = [`{"command":"run-${i}","options":`, "{}", "}"];
      for (const fragment of fragments) {
        messages.push({
          type: "tool_call",
          toolCallId: id,
          toolName: "Bash",
          toolInput: partialToolInput(fragment),
          rawArguments: fragment,
        });
      }
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "done" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("does not stop distinct calls that share an identical fragment tail", async () => {
    // The last streamed fragment of every JSON tool call is `"}`, so a guard
    // that keys on the last partial fragment sees an identical value for
    // distinct commands. Accumulation must use the whole running arguments.
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `call_${i}`;
      const args = bashArgs(4400 + i);
      const head = args.slice(0, args.length - 2);
      const tail = args.slice(args.length - 2);
      messages.push(
        {
          type: "tool_call",
          toolCallId: id,
          toolName: "Bash",
          toolInput: partialToolInput(head),
          rawArguments: head,
        },
        {
          type: "tool_call",
          toolCallId: id,
          toolName: "Bash",
          toolInput: partialToolInput(tail),
          rawArguments: tail,
        },
        { type: "tool_result", toolCallId: id },
      );
    }
    messages.push({ type: "result", success: true, result: "done" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("does not stop when a terminal empty-arguments delta follows each call", async () => {
    // Some streams re-send a terminal `tool_call` message with no parsed
    // arguments (`toolInputFromArguments("")` === `{}`). That trailing empty
    // delta must not overwrite an already-complete call identity.
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `call_${i}`;
      messages.push(...streamedToolCall(id, "Bash", bashArgs(4400 + i)));
      messages.push({
        type: "tool_call",
        toolCallId: id,
        toolName: "Bash",
        toolInput: {},
      });
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "done" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("still stops a subagent that repeats an identical streamed call", async () => {
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `call_${i}`;
      messages.push(...streamedToolCall(id, "Bash", bashArgs(4412)));
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "late" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain("identical Bash call 3 times");
  });

  test("still stops a subagent that repeats an argument-less call", async () => {
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `call_${i}`;
      messages.push({
        type: "tool_call",
        toolCallId: id,
        toolName: "Glob",
        toolInput: {},
        rawArguments: "{}",
      });
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "late" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toContain("identical Glob call 3 times");
  });

  test("judges duplicate results for one call once", async () => {
    // A call can surface more than one result message (local execution plus the
    // server's tool return). Those must not inflate the repeat counter.
    const messages: SdkStreamMessage[] = [
      ...streamedToolCall("call_0", "Bash", bashArgs(4412)),
      { type: "tool_result", toolCallId: "call_0" },
      { type: "tool_result", toolCallId: "call_0" },
      { type: "result", success: true, result: "done" },
    ];

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });

  test("counts streamed fragments as one call for the tool-call budget", async () => {
    // Many argument fragments for a few unique ids must not trip the call
    // budget, which counts calls (unique toolCallIds), not messages.
    const messages: SdkStreamMessage[] = [];
    for (let i = 0; i < 30; i++) {
      const id = `call_${i}`;
      messages.push(...streamedToolCall(id, "Bash", bashArgs(4400 + i)));
      messages.push({ type: "tool_result", toolCallId: id });
    }
    messages.push({ type: "result", success: true, result: "done" });

    const outcome = await createSdkSpawner(fakeClient(messages), CONFIG)(
      request(),
      new AbortController().signal,
    );
    expect(outcome).toMatchObject({ value: "done", failed: false });
  });
});
