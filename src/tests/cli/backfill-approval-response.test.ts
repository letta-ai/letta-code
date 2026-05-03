import { describe, expect, test } from "bun:test";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { createBuffers } from "../../cli/helpers/accumulator";
import { backfillBuffers } from "../../cli/helpers/backfill";

describe("backfill approval response handling", () => {
  test("merges local approval requests and tool returns into tool call lines", () => {
    const buffers = createBuffers();
    const history = [
      {
        id: "approval-request-1",
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: "call-1",
          name: "ShellCommand",
          arguments: JSON.stringify({ command: "pwd" }),
        },
      },
      {
        id: "tool-return-1",
        message_type: "tool_return_message",
        tool_call_id: "call-1",
        status: "success",
        tool_return: "/tmp/project",
      },
    ] as unknown as Message[];

    backfillBuffers(buffers, history);

    const lineId = buffers.toolCallIdToLineId.get("call-1");
    expect(lineId).toBe("approval-request-1");
    const line = lineId ? buffers.byId.get(lineId) : undefined;
    expect(line).toMatchObject({
      kind: "tool_call",
      toolCallId: "call-1",
      name: "ShellCommand",
      argsText: JSON.stringify({ command: "pwd" }),
      resultText: "/tmp/project",
      resultOk: true,
      phase: "finished",
    });
  });

  test("merges local approval responses into tool call lines", () => {
    const buffers = createBuffers();
    const history = [
      {
        id: "approval-request-1",
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: "call-1",
          name: "ShellCommand",
          arguments: JSON.stringify({ command: "pwd" }),
        },
      },
      {
        id: "approval-response-1",
        message_type: "approval_response_message",
        approvals: [
          {
            type: "tool",
            tool_call_id: "call-1",
            status: "success",
            tool_return: "/tmp/project",
          },
        ],
      },
    ] as unknown as Message[];

    backfillBuffers(buffers, history);

    const lineId = buffers.toolCallIdToLineId.get("call-1");
    expect(lineId).toBe("approval-request-1");
    const line = lineId ? buffers.byId.get(lineId) : undefined;
    expect(line).toMatchObject({
      kind: "tool_call",
      toolCallId: "call-1",
      name: "ShellCommand",
      argsText: JSON.stringify({ command: "pwd" }),
      resultText: "/tmp/project",
      resultOk: true,
      phase: "finished",
    });
  });

  test("handles approval responses that appear before requests in equal-timestamp backfill", () => {
    const buffers = createBuffers();
    const history = [
      {
        id: "assistant-1",
        message_type: "assistant_message",
        content: [{ type: "text", text: "Done" }],
      },
      {
        id: "approval-response-1",
        message_type: "approval_response_message",
        approvals: [
          {
            type: "tool",
            tool_call_id: "call-1",
            status: "success",
            tool_return: "moved files",
          },
        ],
      },
      {
        id: "approval-request-1",
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: "call-1",
          name: "ShellCommand",
          arguments: JSON.stringify({ command: "mv *.png Screenshots/" }),
        },
      },
    ] as unknown as Message[];

    backfillBuffers(buffers, history);

    const lineId = buffers.toolCallIdToLineId.get("call-1");
    const line = lineId ? buffers.byId.get(lineId) : undefined;
    expect(line).toMatchObject({
      kind: "tool_call",
      toolCallId: "call-1",
      resultText: "moved files",
      resultOk: true,
      phase: "finished",
    });
  });
});
