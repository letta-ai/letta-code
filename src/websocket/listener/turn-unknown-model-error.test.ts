import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import { handleIncomingMessage } from "./turn";

class Socket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
}

afterEach(() => setActiveRuntime(null));

/**
 * LET-13253: a turn whose conversation model is unknown to the bundled
 * runtime catalog must surface an actionable error to app-server clients
 * (Desktop), not vanish after entering processing. Drives a real LocalBackend
 * turn through the listener the way Desktop's local connection does.
 */
test("listener surfaces unknown-model turn failures to subscribed clients", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "unknown-model-listener-"));
  try {
    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Unknown model target",
      model: "anthropic/claude-opus-9-9",
    } as never);
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    setActiveRuntime(listener);
    const options = {
      connectionId: "source",
      wsUrl: "ws://test",
      deviceId: "source",
      connectionName: "Source",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };
    const socket = new Socket();
    openListenerConnection({
      runtime: listener,
      connectionId: "source",
      writer: socket as never,
      options,
    }).initialized = true;
    subscribeListenerConnection(listener, "source", {
      agent_id: agent.id,
      conversation_id: conversation.id,
    } as never);

    const accepted = mock(() => {});
    // Two sequential messages, matching the reported pair of eaten turns.
    for (const text of ["first message", "second message"]) {
      dispatchInboundMessageWhenReady({
        listener,
        runtime,
        incoming: {
          type: "message",
          agentId: agent.id,
          conversationId: conversation.id,
          messages: [{ role: "user", content: text }],
        },
        socket: socket as never,
        options: options as never,
        processIncomingMessage: handleIncomingMessage,
        processQueuedTurn: async () => {
          throw new Error("idle input should start directly");
        },
        trackListenerError: (_type: string, error: unknown) => {
          throw error;
        },
        onInputAccepted: accepted,
      } as never);
      await runtime.messageQueue;
    }

    const deltas = socket.sent.filter(
      (message) => message.type === "stream_delta",
    );
    const errorDeltas = deltas.filter((message) => {
      const delta = message.delta as Record<string, unknown>;
      return delta.message_type === "error_message";
    });
    expect(errorDeltas).toHaveLength(2);
    for (const errorDelta of errorDeltas) {
      const delta = errorDelta.delta as Record<string, unknown>;
      expect(delta.message).toBe(
        'Unknown model "claude-opus-9-9" for provider "anthropic". ' +
          "Choose an available model with /model.",
      );
    }

    const finished = socket.sent.filter(
      (message) => message.type === "turn_finished",
    );
    expect(finished).toHaveLength(2);
    for (const finish of finished) {
      expect(finish.stop_reason).toBe("error");
      expect(String(finish.error)).toContain("Unknown model");
      expect(String(finish.error)).toContain("claude-opus-9-9");
    }

    expect(runtime.turnLifecycle.kind).toBe("idle");
  } finally {
    __testSetBackend(null);
    await rm(storageDir, { recursive: true, force: true });
  }
}, 30_000);
