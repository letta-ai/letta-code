import { describe, expect, test } from "bun:test";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  emitLocalToolCalls,
  emitLocalToolReturns,
} from "./headless-tool-events";

/**
 * Capture the JSON lines written via writeWireMessage (which uses console.log)
 * without mock.module — swap console.log locally and restore it afterwards.
 */
function captureWireLines(fn: () => void): Array<Record<string, unknown>> {
  const original = console.log;
  const lines: Array<Record<string, unknown>> = [];
  console.log = (msg?: unknown) => {
    if (typeof msg === "string") lines.push(JSON.parse(msg));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe("emitLocalToolReturns", () => {
  test("emits a tool_return_message per executed tool", () => {
    const results: ApprovalResult[] = [
      {
        type: "tool",
        tool_call_id: "call_1",
        status: "success",
        tool_return: "hello",
        stdout: ["hello"],
      },
      {
        type: "tool",
        tool_call_id: "call_2",
        status: "error",
        tool_return: "boom",
      },
    ];

    const lines = captureWireLines(() =>
      emitLocalToolReturns(results, "agent-x"),
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      type: "message",
      message_type: "tool_return_message",
      tool_call_id: "call_1",
      status: "success",
      tool_return: "hello",
      stdout: ["hello"],
      session_id: "agent-x",
      uuid: "tool-return-call_1",
    });
    expect(lines[1]).toMatchObject({
      tool_call_id: "call_2",
      status: "error",
      tool_return: "boom",
    });
  });

  test("stringifies multimodal tool_return content", () => {
    const results = [
      {
        type: "tool",
        tool_call_id: "c",
        status: "success",
        tool_return: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
    ] as unknown as ApprovalResult[];

    const [line] = captureWireLines(() => emitLocalToolReturns(results, "s"));

    expect(line?.tool_return).toBe("a\nb");
  });

  test("emits denied approvals as error returns", () => {
    const results = [
      {
        type: "approval",
        tool_call_id: "c",
        approve: false,
        reason: "Denied by live test",
      },
    ] as unknown as ApprovalResult[];

    const [line] = captureWireLines(() => emitLocalToolReturns(results, "s"));

    expect(line).toMatchObject({
      type: "message",
      message_type: "tool_return_message",
      tool_call_id: "c",
      status: "error",
      tool_return:
        "Error: request to call tool denied. User reason: Denied by live test",
      session_id: "s",
      uuid: "tool-return-c",
    });
  });
});

describe("emitLocalToolCalls", () => {
  test("emits a normalized tool_call_message per decision", () => {
    const decisions = [
      {
        approval: {
          toolCallId: "call_1",
          toolName: "Bash",
          toolArgs: '{"command":"ls"}',
        },
      },
    ];

    const [line] = captureWireLines(() =>
      emitLocalToolCalls(decisions, "agent-x"),
    );

    expect(line).toMatchObject({
      type: "message",
      message_type: "tool_call_message",
      session_id: "agent-x",
      uuid: "tool-call-call_1",
    });
    expect(line?.tool_call).toMatchObject({
      name: "Bash",
      tool_call_id: "call_1",
      arguments: '{"command":"ls"}',
    });
  });

  test("defaults empty tool args to {}", () => {
    const decisions = [
      { approval: { toolCallId: "c", toolName: "Read", toolArgs: "" } },
    ];

    const [line] = captureWireLines(() => emitLocalToolCalls(decisions, "s"));

    expect(line?.tool_call).toMatchObject({ arguments: "{}" });
  });
});
