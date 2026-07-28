import { describe, expect, test } from "bun:test";
import type { StreamDelta } from "@/types/protocol_v2";
import {
  collectToolLifecycleEvents,
  createToolLifecycleTracker,
  type ToolCallEvent,
  type ToolLifecycleCallback,
} from "@/websocket/app-server-openai-tools";

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/** Build a `tool_call_message` StreamDelta. */
function toolCallDelta(
  toolCallId: string,
  name: string | null,
  args: string | null,
  extra?: Record<string, unknown>,
): StreamDelta {
  return {
    type: "message",
    message_type: "tool_call_message",
    id: `msg-${toolCallId}`,
    date: new Date().toISOString(),
    tool_call: {
      ...(name !== null ? { name } : {}),
      tool_call_id: toolCallId,
      ...(args !== null ? { arguments: args } : {}),
    },
    ...extra,
  } as unknown as StreamDelta;
}

/** Build an `approval_request_message` StreamDelta. */
function approvalRequestDelta(
  toolCallId: string,
  name: string | null,
  args: string | null,
): StreamDelta {
  return {
    type: "message",
    message_type: "approval_request_message",
    id: `msg-approval-${toolCallId}`,
    date: new Date().toISOString(),
    tool_call: {
      ...(name !== null ? { name } : {}),
      tool_call_id: toolCallId,
      ...(args !== null ? { arguments: args } : {}),
    },
  } as unknown as StreamDelta;
}

/** Build a `tool_return_message` StreamDelta with singular fields. */
function toolReturnDelta(
  toolCallId: string,
  status: "success" | "error",
  toolReturn: string,
): StreamDelta {
  return {
    type: "message",
    message_type: "tool_return_message",
    id: `msg-return-${toolCallId}`,
    date: new Date().toISOString(),
    tool_call_id: toolCallId,
    status,
    tool_return: toolReturn,
  } as unknown as StreamDelta;
}

/** Build a `tool_return_message` StreamDelta with plural `tool_returns`. */
function toolReturnPluralDelta(
  returns: Array<{
    tool_call_id: string;
    status: "success" | "error";
    tool_return: string;
  }>,
): StreamDelta {
  return {
    type: "message",
    message_type: "tool_return_message",
    id: `msg-return-plural-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    tool_returns: returns,
  } as unknown as StreamDelta;
}

function clientToolStartDelta(toolCallId: string, name: string): StreamDelta {
  return {
    message_type: "client_tool_start",
    id: `client-start-${toolCallId}`,
    date: new Date().toISOString(),
    tool_call_id: toolCallId,
    tool_name: name,
  } as StreamDelta;
}

function clientToolEndDelta(
  toolCallId: string,
  status: "success" | "error",
): StreamDelta {
  return {
    message_type: "client_tool_end",
    id: `client-end-${toolCallId}`,
    date: new Date().toISOString(),
    tool_call_id: toolCallId,
    status,
  } as StreamDelta;
}

/** Build a non-tool StreamDelta (e.g. assistant message). */
function assistantDelta(text: string): StreamDelta {
  return {
    type: "message",
    message_type: "assistant_message",
    id: `msg-assistant-${crypto.randomUUID()}`,
    date: new Date().toISOString(),
    content: text,
  } as unknown as StreamDelta;
}

function eventTypes(events: ToolCallEvent[]): string[] {
  return events.map((e) => e.type);
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("createToolLifecycleTracker", () => {
  test("emits start, arguments_delta, and complete for a single tool call", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", '{"command":"ls"}'),
      toolReturnDelta("call-1", "success", "file1\nfile2"),
    ]);

    expect(eventTypes(events)).toEqual([
      "tool_call_start",
      "tool_call_arguments_delta",
      "tool_call_complete",
    ]);

    const start = events[0] as Extract<
      ToolCallEvent,
      { type: "tool_call_start" }
    >;
    expect(start).toMatchObject({
      type: "tool_call_start",
      tool_call_id: "call-1",
      tool_name: "Bash",
    });

    const argsDelta = events[1] as Extract<
      ToolCallEvent,
      { type: "tool_call_arguments_delta" }
    >;
    expect(argsDelta).toMatchObject({
      type: "tool_call_arguments_delta",
      tool_call_id: "call-1",
      arguments_delta: '{"command":"ls"}',
    });

    const complete = events[2] as Extract<
      ToolCallEvent,
      { type: "tool_call_complete" }
    >;
    expect(complete).toMatchObject({
      type: "tool_call_complete",
      tool_call_id: "call-1",
      tool_name: "Bash",
      arguments: '{"command":"ls"}',
      output: "file1\nfile2",
      success: true,
    });
  });

  test("aggregates partial arguments across multiple tool_call_messages", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", '{"command":'),
      toolCallDelta("call-1", null, '"ls"}'),
      toolReturnDelta("call-1", "success", "done"),
    ]);

    const argDeltas = events.filter(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_arguments_delta" }> =>
        e.type === "tool_call_arguments_delta",
    );
    expect(argDeltas).toHaveLength(2);
    expect(argDeltas[0]?.arguments_delta).toBe('{"command":');
    expect(argDeltas[1]?.arguments_delta).toBe('"ls"}');

    const complete = events.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete",
    );
    expect(complete?.arguments).toBe('{"command":"ls"}');
  });

  test("emits start only once even if multiple fragments arrive", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", '{"command":"ls"}'),
      toolCallDelta("call-1", null, '{"cwd":"/tmp"}'),
      toolReturnDelta("call-1", "success", "ok"),
    ]);

    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(1);
  });

  test("handles approval_request_message the same as tool_call_message", () => {
    const events = collectToolLifecycleEvents([
      approvalRequestDelta("call-2", "Read", '{"path":"/etc/hosts"}'),
      toolReturnDelta("call-2", "success", "127.0.0.1 localhost"),
    ]);

    expect(eventTypes(events)).toEqual([
      "tool_call_start",
      "tool_call_arguments_delta",
      "tool_call_complete",
    ]);

    const start = events[0] as Extract<
      ToolCallEvent,
      { type: "tool_call_start" }
    >;
    expect(start.tool_name).toBe("Read");
  });

  test("handles plural tool_returns in a single tool_return_message", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-a", "Bash", '{"command":"ls"}'),
      toolCallDelta("call-b", "Read", '{"path":"file.txt"}'),
      toolReturnPluralDelta([
        { tool_call_id: "call-a", status: "success", tool_return: "out-a" },
        { tool_call_id: "call-b", status: "error", tool_return: "err-b" },
      ]),
    ]);

    const completes = events.filter((e) => e.type === "tool_call_complete");
    expect(completes).toHaveLength(2);

    const completeA = completes.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete" && e.tool_call_id === "call-a",
    );
    expect(completeA).toMatchObject({
      tool_call_id: "call-a",
      output: "out-a",
      success: true,
      arguments: '{"command":"ls"}',
    });

    const completeB = completes.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete" && e.tool_call_id === "call-b",
    );
    expect(completeB).toMatchObject({
      tool_call_id: "call-b",
      output: "err-b",
      success: false,
      arguments: '{"path":"file.txt"}',
    });
  });

  test("avoids duplicate complete events for repeated tool_return_messages", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", '{"command":"ls"}'),
      toolReturnDelta("call-1", "success", "first"),
      toolReturnDelta("call-1", "success", "second"),
    ]);

    const completes = events.filter((e) => e.type === "tool_call_complete");
    expect(completes).toHaveLength(1);
    expect((completes[0] as { output: string }).output).toBe("first");
  });

  test("waits for the terminal client-tool result instead of completing from progress snapshots", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-stream", "Bash", '{"command":"build"}'),
      clientToolStartDelta("call-stream", "Bash"),
      toolReturnDelta("call-stream", "success", "building 10%"),
      toolReturnDelta("call-stream", "success", "building 90%"),
      clientToolEndDelta("call-stream", "success"),
      toolReturnDelta("call-stream", "success", "build complete"),
    ]);

    const completes = events.filter(
      (
        event,
      ): event is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        event.type === "tool_call_complete",
    );
    expect(completes).toHaveLength(1);
    expect(completes[0]).toMatchObject({
      output: "build complete",
      success: true,
    });
  });

  test("uses the terminal client-tool failure instead of an earlier successful snapshot", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-fail", "Bash", '{"command":"build"}'),
      clientToolStartDelta("call-fail", "Bash"),
      toolReturnDelta("call-fail", "success", "building 10%"),
      clientToolEndDelta("call-fail", "error"),
      toolReturnDelta("call-fail", "error", "compiler failed"),
    ]);

    expect(events.at(-1)).toMatchObject({
      type: "tool_call_complete",
      output: "compiler failed",
      success: false,
    });
  });

  test("ignores tool_call_message fragments that arrive after completion", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", '{"command":"ls"}'),
      toolReturnDelta("call-1", "success", "done"),
      toolCallDelta("call-1", null, '{"extra":true}'),
    ]);

    const argDeltas = events.filter(
      (e) => e.type === "tool_call_arguments_delta",
    );
    expect(argDeltas).toHaveLength(1);
    expect(argDeltas[0]?.arguments_delta).toBe('{"command":"ls"}');
  });

  test("ignores non-tool StreamDelta types", () => {
    const events = collectToolLifecycleEvents([
      assistantDelta("hello world"),
      toolCallDelta("call-1", "Bash", "{}"),
      toolReturnDelta("call-1", "success", "ok"),
    ]);

    // Only the tool call events should be present, not anything from
    // the assistant message.
    expect(events).toHaveLength(3);
    expect(eventTypes(events)).toEqual([
      "tool_call_start",
      "tool_call_arguments_delta",
      "tool_call_complete",
    ]);
  });

  test("handles tool_call_message with tool_calls array", () => {
    const delta: StreamDelta = {
      type: "message",
      message_type: "tool_call_message",
      id: "msg-multi",
      date: new Date().toISOString(),
      tool_calls: [
        { name: "Bash", tool_call_id: "call-x", arguments: '{"command":"ls"}' },
        { name: "Read", tool_call_id: "call-y", arguments: '{"path":"f"}' },
      ],
    } as unknown as StreamDelta;

    const events = collectToolLifecycleEvents([
      delta,
      toolReturnPluralDelta([
        { tool_call_id: "call-x", status: "success", tool_return: "x-out" },
        { tool_call_id: "call-y", status: "success", tool_return: "y-out" },
      ]),
    ]);

    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(2);
    expect((starts[0] as { tool_call_id: string }).tool_call_id).toBe("call-x");
    expect((starts[1] as { tool_call_id: string })?.tool_call_id).toBe(
      "call-y",
    );
  });

  test("handles tool_call_message with null/absent name in first fragment", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", null, '{"command":"ls"}'),
      toolReturnDelta("call-1", "success", "ok"),
    ]);

    const start = events[0] as Extract<
      ToolCallEvent,
      { type: "tool_call_start" }
    >;
    expect(start.tool_name).toBeNull();
  });

  test("handles tool_return with multimodal content parts", () => {
    const delta: StreamDelta = {
      type: "message",
      message_type: "tool_return_message",
      id: "msg-return-mm",
      date: new Date().toISOString(),
      tool_call_id: "call-1",
      status: "success",
      tool_return: [
        { type: "text", text: "line1" },
        { type: "text", text: "line2" },
      ],
    } as unknown as StreamDelta;

    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", "{}"),
      delta,
    ]);

    const complete = events.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete",
    );
    expect(complete?.output).toBe("line1\nline2");
  });

  test("handles tool_return with null tool_return value", () => {
    const delta: StreamDelta = {
      type: "message",
      message_type: "tool_return_message",
      id: "msg-return-null",
      date: new Date().toISOString(),
      tool_call_id: "call-1",
      status: "success",
      tool_return: null,
    } as unknown as StreamDelta;

    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", "{}"),
      delta,
    ]);

    const complete = events.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete",
    );
    expect(complete?.output).toBe("");
  });

  test("dispose stops event emission", () => {
    const collected: ToolCallEvent[] = [];
    const tracker = createToolLifecycleTracker((event) => {
      collected.push(event);
    });

    tracker.process(toolCallDelta("call-1", "Bash", "{}"));
    expect(collected).toHaveLength(2); // start + arguments_delta

    tracker.dispose();

    tracker.process(toolReturnDelta("call-1", "success", "ok"));
    expect(collected).toHaveLength(2); // no new events after dispose
  });

  test("failPending completes unfinished calls as errors", () => {
    const collected: ToolCallEvent[] = [];
    const tracker = createToolLifecycleTracker((event) => {
      collected.push(event);
    });
    tracker.process(toolCallDelta("call-1", "Bash", "{}"));

    tracker.failPending("interactive approval is not supported");
    tracker.failPending("duplicate");

    expect(collected.at(-1)).toMatchObject({
      type: "tool_call_complete",
      tool_call_id: "call-1",
      output: "interactive approval is not supported",
      success: false,
    });
    expect(
      collected.filter((event) => event.type === "tool_call_complete"),
    ).toHaveLength(1);
  });

  test("callback is invoked synchronously during process", () => {
    const order: string[] = [];
    const callback: ToolLifecycleCallback = (event) => {
      order.push(event.type);
    };
    const tracker = createToolLifecycleTracker(callback);

    tracker.process(toolCallDelta("call-1", "Bash", '{"command":"ls"}'));
    tracker.process(toolReturnDelta("call-1", "success", "done"));
    tracker.dispose();

    expect(order).toEqual([
      "tool_call_start",
      "tool_call_arguments_delta",
      "tool_call_complete",
    ]);
  });

  test("handles multiple independent tool calls interleaved", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-a", "Bash", '{"command":"ls"}'),
      toolCallDelta("call-b", "Read", '{"path":"f"}'),
      toolReturnDelta("call-a", "success", "a-out"),
      toolReturnDelta("call-b", "error", "b-err"),
    ]);

    const starts = events.filter((e) => e.type === "tool_call_start");
    expect(starts).toHaveLength(2);

    const completes = events.filter((e) => e.type === "tool_call_complete");
    expect(completes).toHaveLength(2);

    const completeA = completes.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete" && e.tool_call_id === "call-a",
    );
    expect(completeA?.success).toBe(true);

    const completeB = completes.find(
      (e): e is Extract<ToolCallEvent, { type: "tool_call_complete" }> =>
        e.type === "tool_call_complete" && e.tool_call_id === "call-b",
    );
    expect(completeB?.success).toBe(false);
  });

  test("tool_call_message with empty arguments does not emit arguments_delta", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", null),
      toolReturnDelta("call-1", "success", "ok"),
    ]);

    expect(eventTypes(events)).toEqual([
      "tool_call_start",
      "tool_call_complete",
    ]);
  });

  test("tool_call_message with empty string arguments emits arguments_delta", () => {
    const events = collectToolLifecycleEvents([
      toolCallDelta("call-1", "Bash", ""),
      toolReturnDelta("call-1", "success", "ok"),
    ]);

    // Empty string is still a valid (if empty) arguments fragment.
    const argDeltas = events.filter(
      (e) => e.type === "tool_call_arguments_delta",
    );
    expect(argDeltas).toHaveLength(1);
    expect((argDeltas[0] as { arguments_delta: string })?.arguments_delta).toBe(
      "",
    );
  });
});
