import { expect, test } from "bun:test";
import WebSocket from "ws";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { createConversationRuntime } from "@/websocket/listener/runtime";
import { safeSocketSend } from "@/websocket/listener/socket-send";
import { handleTaskControlCommand } from "./task-control";

for (const relay of [true, false]) {
  test(`${relay ? "relay" : "local"} steer reply after relay reconnect`, async () => {
    const runtime = createRuntime();
    runtime.connectionId = "relay-old";
    const sent: string[] = [];
    const original = Object.create(WebSocket.prototype) as WebSocket;
    const replacement = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(original, "readyState", {
      value: WebSocket.OPEN,
      configurable: true,
    });
    Object.defineProperty(replacement, "readyState", { value: WebSocket.OPEN });
    replacement.send = (data) => {
      sent.push(String(data));
    };
    runtime.socket = original;
    let pending: Promise<void> | undefined;
    await handleTaskControlCommand(
      {
        type: "subagent_message",
        request_id: "reconnect",
        runtime: { agent_id: "agent-a", conversation_id: "conv-a" },
        agent_id: "missing-worker",
        message: "Continue",
      },
      {
        runtime,
        socket: original,
        connectionId: relay ? "relay-old" : "local-client",
        getOrCreateScopedRuntime: createConversationRuntime,
        runDetachedListenerTask: (_name, task) => {
          pending = task();
          Object.defineProperty(original, "readyState", {
            value: WebSocket.CLOSED,
          });
          runtime.connectionId = "relay-new";
          runtime.socket = replacement;
        },
        safeSocketSend,
      },
    );
    await pending;
    expect(sent).toHaveLength(relay ? 1 : 0);
    if (relay)
      expect(JSON.parse(sent[0] ?? "{}").type).toBe(
        "subagent_message_response",
      );
  });
}
