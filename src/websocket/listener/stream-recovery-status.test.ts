import { describe, expect, test } from "bun:test";
import type { StreamDeltaMessage } from "@/types/protocol_v2";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { emitStreamRecoveryStatusDeltas } from "./stream-recovery-status";
import type { LocalTransport } from "./transport";
import type { StartListenerOptions } from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

function parseStatusDeltas(transport: MockTransport): StreamDeltaMessage[] {
  return transport.sent.map((data) => JSON.parse(data) as StreamDeltaMessage);
}

function createTestRuntime(transport: MockTransport) {
  const listener = createRuntime();
  const options: StartListenerOptions = {
    connectionId: "test-connection",
    wsUrl: "local://test",
    deviceId: "test-device",
    connectionName: "test-connection",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(listener, options.connectionId);
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: "agent-1",
    conversation_id: "conversation-1",
  });
  return getOrCreateScopedRuntime(listener, "agent-1", "conversation-1");
}

describe("stream recovery status", () => {
  test("emits the silent-stream recovery warning to listener clients", () => {
    const transport = new MockTransport();
    const runtime = createTestRuntime(transport);

    emitStreamRecoveryStatusDeltas(transport, runtime, {
      stallReconcilerFired: true,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });

    const [frame] = parseStatusDeltas(transport);
    expect(frame?.type).toBe("stream_delta");
    expect(frame?.runtime).toEqual({
      agent_id: "agent-1",
      conversation_id: "conversation-1",
    });
    expect(frame?.delta).toMatchObject({
      message_type: "status",
      level: "warning",
      message: "Stream went silent, reconnecting to recover the missed tail",
      run_id: "run-1",
    });
  });

  test("preserves the terminal-EOF warning and stays silent without recovery", () => {
    const transport = new MockTransport();
    const runtime = createTestRuntime(transport);

    emitStreamRecoveryStatusDeltas(transport, runtime, {
      terminalEofGuardFired: true,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conversation-1",
    });
    emitStreamRecoveryStatusDeltas(transport, runtime, {
      agentId: "agent-1",
      conversationId: "conversation-1",
    });

    const frames = parseStatusDeltas(transport);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.delta).toMatchObject({
      message_type: "status",
      level: "warning",
      message:
        "Stream did not close after completing, continued without waiting",
      run_id: "run-1",
    });
  });
});
