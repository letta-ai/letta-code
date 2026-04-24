import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { StreamJsonAggregator } from "../../streamJsonAggregator";

// The aggregator emits via writeWireMessage → console.log(JSON.stringify(...)).
// We capture console.log to inspect emissions.
const originalConsoleLog = console.log;
let consoleLog: ReturnType<typeof mock>;

function getEmissions(): Array<Record<string, unknown>> {
  return consoleLog.mock.calls.map(
    (args) => JSON.parse(String(args[0])) as Record<string, unknown>,
  );
}

/** Get the Nth emission or fail the test. Keeps call sites clean. */
function emission(n: number): Record<string, unknown> {
  const emissions = getEmissions();
  const e = emissions[n];
  if (e === undefined) {
    throw new Error(
      `expected at least ${n + 1} emissions, got ${emissions.length}`,
    );
  }
  return e;
}

function aggregator(
  overrides: Partial<{
    sessionId: string;
    agentId: string;
    conversationId: string;
    passthrough: boolean;
  }> = {},
): StreamJsonAggregator {
  return new StreamJsonAggregator({
    sessionId: "session-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    passthrough: false,
    ...overrides,
  });
}

beforeEach(() => {
  consoleLog = mock((..._args: unknown[]) => {});
  console.log = consoleLog as typeof console.log;
});

afterEach(() => {
  console.log = originalConsoleLog;
});

describe("StreamJsonAggregator", () => {
  test("coalesces two assistant_message chunks with the same otid", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-a",
      content: "Hello ",
    } as never);
    agg.ingest({
      message_type: "assistant_message",
      id: "msg-1",
      otid: "otid-a",
      content: "world",
    } as never);
    // Nothing emitted yet — waiting for a flush trigger.
    expect(getEmissions()).toHaveLength(0);

    agg.flushAll();
    const out = emission(0);
    expect(out.message_type).toBe("assistant_message");
    expect(out.content).toBe("Hello world");
    expect(out.otid).toBe("otid-a");
    expect(out.uuid).toBe("otid-a");
    expect(out.session_id).toBe("session-1");
  });

  test("coalesces two reasoning_message chunks with the same otid", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "reasoning_message",
      id: "rmsg-1",
      otid: "otid-r",
      reasoning: "Let me think ",
    } as never);
    agg.ingest({
      message_type: "reasoning_message",
      id: "rmsg-1",
      otid: "otid-r",
      reasoning: "about this.",
    } as never);
    agg.flushAll();

    const out = emission(0);
    expect(out.message_type).toBe("reasoning_message");
    expect(out.reasoning).toBe("Let me think about this.");
  });

  test("coalesces tool_call_message arguments with the same tool_call_id", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "tool_call_message",
      otid: "otid-tc",
      tool_call: {
        tool_call_id: "call-1",
        name: "Read",
        arguments: '{"file":"',
      },
    } as never);
    agg.ingest({
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-1",
        name: "Read",
        arguments: "/tmp/x.txt",
      },
    } as never);
    agg.ingest({
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-1",
        name: "Read",
        arguments: '"}',
      },
    } as never);
    agg.flushAll();

    const out = emission(0);
    expect(out.message_type).toBe("tool_call_message");
    const toolCall = out.tool_call as Record<string, string>;
    expect(toolCall.tool_call_id).toBe("call-1");
    expect(toolCall.name).toBe("Read");
    expect(toolCall.arguments).toBe('{"file":"/tmp/x.txt"}');
    // Parse as valid JSON — the whole point of coalescing.
    expect(() => JSON.parse(toolCall.arguments as string)).not.toThrow();
  });

  test("coalesces approval_request_message arguments with the same tool_call_id", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "approval_request_message",
      otid: "otid-ap",
      tool_call: {
        tool_call_id: "call-ap",
        name: "Bash",
        arguments: null,
      },
    } as never);
    agg.ingest({
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "call-ap",
        name: "Bash",
        arguments: '{"command":"ls"}',
      },
    } as never);
    agg.flushAll();

    const out = emission(0);
    expect(out.message_type).toBe("approval_request_message");
    const toolCall = out.tool_call as Record<string, unknown>;
    expect(toolCall.arguments).toBe('{"command":"ls"}');
    // Previous `arguments: null` chunk is not visible.
    // Wire uuid is derived from tool_call_id, not the shared otid.
    expect(out.uuid).toBe("call-ap");
  });

  test("parallel tool calls in the same server message get distinct wire uuids", () => {
    // Server often emits multiple tool calls in a single message (shared
    // otid/id). Each emission must end up with a distinct uuid derived from
    // its tool_call_id — otherwise consumers can't tell the events apart.
    const agg = aggregator();
    const sharedOtid = "message-parallel";
    agg.ingest({
      message_type: "approval_request_message",
      id: sharedOtid,
      otid: sharedOtid,
      tool_call: {
        tool_call_id: "call-a",
        name: "Read",
        arguments: '{"file":"a"}',
      },
    } as never);
    agg.ingest({
      message_type: "approval_request_message",
      id: sharedOtid,
      otid: sharedOtid,
      tool_call: {
        tool_call_id: "call-b",
        name: "Read",
        arguments: '{"file":"b"}',
      },
    } as never);
    agg.ingest({
      message_type: "approval_request_message",
      id: sharedOtid,
      otid: sharedOtid,
      tool_call: {
        tool_call_id: "call-c",
        name: "Read",
        arguments: '{"file":"c"}',
      },
    } as never);
    agg.flushAll();

    const emissions = getEmissions();
    expect(emissions).toHaveLength(3);
    const uuids = emissions.map((e) => e.uuid);
    expect(uuids).toEqual(["call-a", "call-b", "call-c"]);
    // Each emission's uuid matches its own tool_call_id.
    for (const e of emissions) {
      const tc = e.tool_call as Record<string, unknown>;
      expect(e.uuid).toBe(tc.tool_call_id);
    }
  });

  test("tool_return_message flushes its matching tool_call first, then passes through", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "call-42",
        name: "Read",
        arguments: '{"file":"x"}',
      },
    } as never);
    // No flush yet.
    expect(getEmissions()).toHaveLength(0);

    agg.ingest({
      message_type: "tool_return_message",
      tool_call_id: "call-42",
      tool_return: "contents",
      status: "success",
    } as never);

    // Both emitted: the flushed tool call first, then the tool return.
    expect(getEmissions()).toHaveLength(2);
    expect(emission(0).message_type).toBe("approval_request_message");
    expect(emission(1).message_type).toBe("tool_return_message");
  });

  test("stop_reason: end_turn merges inline onto the last assistant_message", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-final",
      content: "All done.",
    } as never);

    agg.ingest({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);
    agg.ingest({
      message_type: "usage_statistics",
      completion_tokens: 7,
      prompt_tokens: 11,
      total_tokens: 18,
      step_count: 1,
    } as never);

    // One coalesced wire event carrying content + stop_reason + usage.
    expect(getEmissions()).toHaveLength(1);
    expect(emission(0).message_type).toBe("assistant_message");
    expect(emission(0).content).toBe("All done.");
    expect(emission(0).stop_reason).toBe("end_turn");
    expect(emission(0).usage).toMatchObject({
      completion_tokens: 7,
      prompt_tokens: 11,
      total_tokens: 18,
      step_count: 1,
    });
  });

  test("stop_reason: end_turn falls back to last reasoning_message when no assistant present", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "reasoning_message",
      otid: "reason-1",
      reasoning: "thinking...",
    } as never);
    agg.ingest({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);
    agg.ingest({
      message_type: "usage_statistics",
      completion_tokens: 1,
    } as never);

    expect(getEmissions()).toHaveLength(1);
    expect(emission(0).message_type).toBe("reasoning_message");
    expect(emission(0).stop_reason).toBe("end_turn");
    expect(emission(0).usage).toMatchObject({ completion_tokens: 1 });
  });

  test("stop_reason: requires_approval merges inline onto the approval_request_message", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "call-merge",
        name: "Bash",
        arguments: '{"command":"ls"}',
      },
    } as never);
    agg.ingest({
      message_type: "stop_reason",
      stop_reason: "requires_approval",
    } as never);
    agg.ingest({
      message_type: "usage_statistics",
      completion_tokens: 10,
      prompt_tokens: 100,
      step_count: 1,
    } as never);

    // Single wire event carrying tool_call + stop_reason + usage inline.
    expect(getEmissions()).toHaveLength(1);
    expect(emission(0).message_type).toBe("approval_request_message");
    expect(emission(0).stop_reason).toBe("requires_approval");
    expect(emission(0).usage).toMatchObject({
      completion_tokens: 10,
      prompt_tokens: 100,
      step_count: 1,
    });
  });

  test("stop_reason: error with no content target emits standalone", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "stop_reason",
      stop_reason: "error",
    } as never);
    agg.ingest({
      message_type: "usage_statistics",
      completion_tokens: 0,
    } as never);

    // No content message to attach to → both emit as separate events.
    const emissions = getEmissions();
    expect(emissions.map((e) => e.message_type)).toEqual([
      "stop_reason",
      "usage_statistics",
    ]);
    expect(emission(0).stop_reason).toBe("error");
  });

  test("flushAll emits pending entries even when terminators never arrive (abort path)", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-x",
      content: "partial thought",
    } as never);

    // No stop_reason / usage_statistics ever arrive (abort mid-stream).
    agg.flushAll();
    const emissions = getEmissions();
    expect(emissions.map((e) => e.message_type)).toEqual(["assistant_message"]);
    // No stop_reason / usage on the message since none arrived.
    expect(emission(0).stop_reason).toBeUndefined();
    expect(emission(0).usage).toBeUndefined();
  });

  test("passthrough mode emits each chunk as a stream_event envelope", () => {
    const agg = aggregator({ passthrough: true });
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-p",
      content: "Hello ",
    } as never);
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-p",
      content: "world",
    } as never);
    // No flush required — passthrough is immediate.
    expect(getEmissions()).toHaveLength(2);
    expect(emission(0).type).toBe("stream_event");
    expect(emission(1).type).toBe("stream_event");
    expect((emission(0) as { event: { content: string } }).event.content).toBe(
      "Hello ",
    );
    expect((emission(1) as { event: { content: string } }).event.content).toBe(
      "world",
    );
  });

  test("unknown chunk types flush pending first, then pass through", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-u",
      content: "hi",
    } as never);
    // Unknown type — should flush the assistant_message then pass through.
    agg.ingest({
      message_type: "some_future_type",
      some_field: "value",
    } as never);

    expect(getEmissions()).toHaveLength(2);
    expect(emission(0).message_type).toBe("assistant_message");
    expect(emission(0).content).toBe("hi");
    expect(emission(1).message_type).toBe("some_future_type");
  });

  test("chunks without an otid or id fall back to randomUUID and pass through", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "assistant_message",
      content: "no correlatable id",
    } as never);

    // Should emit immediately (can't merge without a key) — flushAll sweeps
    // nothing since nothing is pending.
    expect(getEmissions()).toHaveLength(1);
    expect(emission(0).message_type).toBe("assistant_message");
    expect(emission(0).content).toBe("no correlatable id");
    expect(typeof emission(0).uuid).toBe("string");
  });

  test("preserves first-seen order across kinds on flush", () => {
    const agg = aggregator();
    agg.ingest({
      message_type: "reasoning_message",
      otid: "otid-r",
      reasoning: "first",
    } as never);
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-a",
      content: "second",
    } as never);
    agg.ingest({
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "call-3",
        name: "Read",
        arguments: "{}",
      },
    } as never);

    agg.flushAll();
    const types = getEmissions().map((e) => e.message_type);
    expect(types).toEqual([
      "reasoning_message",
      "assistant_message",
      "approval_request_message",
    ]);
  });

  test("envelope fields (session_id, agent_id, conversation_id) are stamped on coalesced messages", () => {
    const agg = aggregator({
      sessionId: "S",
      agentId: "A",
      conversationId: "C",
    });
    agg.ingest({
      message_type: "assistant_message",
      otid: "otid-e",
      content: "hi",
    } as never);
    agg.flushAll();

    const out = emission(0);
    expect(out.type).toBe("message");
    expect(out.session_id).toBe("S");
    expect(out.agent_id).toBe("A");
    expect(out.conversation_id).toBe("C");
    expect(out.uuid).toBe("otid-e");
  });

  test("late name metadata on tool_call chunks is preserved across merge", () => {
    const agg = aggregator();
    // First chunk has no name (backend sometimes streams args first).
    agg.ingest({
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-late",
        name: "",
        arguments: '{"a":',
      },
    } as never);
    // Second chunk carries the name.
    agg.ingest({
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-late",
        name: "Glob",
        arguments: '"1"}',
      },
    } as never);
    agg.flushAll();

    const out = emission(0);
    const toolCall = out.tool_call as Record<string, string>;
    expect(toolCall.name).toBe("Glob");
    expect(toolCall.arguments).toBe('{"a":"1"}');
  });
});
