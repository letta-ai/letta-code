import { describe, expect, test } from "bun:test";
import { createBuffers, onChunk } from "@/cli/helpers/accumulator";

describe("unified exec accumulator metadata", () => {
  test("carries original exec command display into write_stdin lines", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "exec-call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "python3 repl.py", tty: true }),
      },
    } as never);

    onChunk(buffers, {
      message_type: "tool_return_message",
      tool_call_id: "exec-call",
      status: "success",
      tool_return: [
        "Chunk ID: abc123",
        "Wall time: 0.1000 seconds",
        "Process running with session ID 8",
        "Original token count: 1",
        "Output:",
        "ready",
      ].join("\n"),
    } as never);

    onChunk(buffers, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "stdin-call",
        name: "write_stdin",
        arguments: JSON.stringify({ session_id: 8, chars: "2 + 2\n" }),
      },
    } as never);

    const line = buffers.byId.get("stdin-call");
    expect(line).toMatchObject({
      kind: "tool_call",
      name: "write_stdin",
      unifiedExecCommandDisplay: "python3 repl.py",
    });
  });

  test("prefers exec command description for write_stdin display", () => {
    const buffers = createBuffers();

    onChunk(buffers, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "exec-call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "python3 repl.py",
          description: "Run Python REPL",
          tty: true,
        }),
      },
    } as never);

    onChunk(buffers, {
      message_type: "tool_return_message",
      tool_call_id: "exec-call",
      status: "success",
      tool_return: [
        "Chunk ID: abc123",
        "Wall time: 0.1000 seconds",
        "Process running with session ID 8",
        "Original token count: 1",
        "Output:",
        "ready",
      ].join("\n"),
    } as never);

    onChunk(buffers, {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "stdin-call",
        name: "write_stdin",
        arguments: JSON.stringify({ session_id: 8, chars: "2 + 2\n" }),
      },
    } as never);

    const line = buffers.byId.get("stdin-call");
    expect(line).toMatchObject({
      kind: "tool_call",
      name: "write_stdin",
      unifiedExecCommandDisplay: "Run Python REPL",
    });
  });
});
