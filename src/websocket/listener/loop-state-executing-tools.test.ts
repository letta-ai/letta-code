import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { emitToolExecutionAbortedEvents } from "./interrupts";
import { createRuntime } from "./lifecycle";
import { buildLoopStatus } from "./protocol-outbound";
import type { ConversationRuntime } from "./types";

class MockSocket {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readyState: number;
  sentPayloads: string[] = [];

  constructor(readyState: number = WebSocket.OPEN) {
    this.readyState = readyState;
  }

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  isOpen(): boolean {
    return this.readyState === WebSocket.OPEN;
  }

  close(): void {}

  removeAllListeners(): this {
    return this;
  }
}

function createScopedRuntime(
  agentId: string = "agent-1",
  conversationId: string = "conv-a",
): ConversationRuntime {
  return getOrCreateScopedRuntime(createRuntime(), agentId, conversationId);
}

function beginTurn(
  runtime: ConversationRuntime,
  options: {
    initialStatus?: Parameters<
      ConversationRuntime["turnLifecycle"]["begin"]
    >[0]["initialStatus"];
    executingToolCallIds?: readonly string[];
  } = {},
) {
  return runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp/test-worktree",
    ...(options.initialStatus ? { initialStatus: options.initialStatus } : {}),
    ...(options.executingToolCallIds
      ? { executingToolCallIds: options.executingToolCallIds }
      : {}),
  });
}

describe("loop state executing tool call ids", () => {
  test("carries the executing tool call ids while executing client-side tools", () => {
    const runtime = createScopedRuntime();

    beginTurn(runtime, {
      initialStatus: "EXECUTING_CLIENT_SIDE_TOOL",
      executingToolCallIds: ["tool-call-1", "tool-call-2"],
    });

    const loopStatus = buildLoopStatus(runtime.listener, {
      agent_id: "agent-1",
      conversation_id: "conv-a",
    });
    expect(loopStatus.status).toBe("EXECUTING_CLIENT_SIDE_TOOL");
    expect(loopStatus.executing_tool_call_ids).toEqual([
      "tool-call-1",
      "tool-call-2",
    ]);
  });

  test("reports an empty executing set outside client-side tool execution", () => {
    const runtime = createScopedRuntime();

    // Lifecycle state can retain the last executing ids (e.g. while the
    // continuation request is in flight); the wire snapshot must not leak
    // them once the reported status is no longer EXECUTING_CLIENT_SIDE_TOOL.
    beginTurn(runtime, {
      initialStatus: "SENDING_API_REQUEST",
      executingToolCallIds: ["tool-call-stale"],
    });

    const loopStatus = buildLoopStatus(runtime.listener, {
      agent_id: "agent-1",
      conversation_id: "conv-a",
    });
    expect(loopStatus.status).toBe("SENDING_API_REQUEST");
    expect(loopStatus.executing_tool_call_ids).toEqual([]);
  });

  test("reports an empty executing set when the conversation is idle", () => {
    const runtime = createScopedRuntime();

    const loopStatus = buildLoopStatus(runtime.listener, {
      agent_id: "agent-1",
      conversation_id: "conv-a",
    });
    expect(loopStatus.status).toBe("WAITING_ON_INPUT");
    expect(loopStatus.executing_tool_call_ids).toEqual([]);
  });
});

describe("emitToolExecutionAbortedEvents", () => {
  test("emits error-status client_tool_end events for every tool call id", () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();

    emitToolExecutionAbortedEvents(socket, runtime, {
      toolCallIds: ["tool-call-1", "tool-call-2"],
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-a",
    });

    const deltas = socket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .filter((frame) => frame.type === "stream_delta")
      .map((frame) => frame.delta);
    expect(deltas).toHaveLength(2);
    for (const delta of deltas) {
      expect(delta.message_type).toBe("client_tool_end");
      expect(delta.status).toBe("error");
      expect(delta.run_id).toBe("run-1");
    }
    expect(deltas.map((delta) => delta.tool_call_id)).toEqual([
      "tool-call-1",
      "tool-call-2",
    ]);
  });

  test("emits nothing for an empty tool call id list", () => {
    const runtime = createScopedRuntime();
    const socket = new MockSocket();

    emitToolExecutionAbortedEvents(socket, runtime, {
      toolCallIds: [],
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-a",
    });

    expect(socket.sentPayloads).toHaveLength(0);
  });
});
