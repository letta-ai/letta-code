import { expect, test } from "bun:test";
import WebSocket from "ws";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { consumeQueuedTurn } from "./queue";

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

function queuedMessage(clientMessageId: string) {
  return {
    type: "message" as const,
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: [
      {
        role: "user" as const,
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

test("active continuation dequeue emits exact message identities", async () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conv-1",
  );
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;
  runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp/queue-update-transitions",
  });

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-1"))).toBe(true);
  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-2"))).toBe(true);
  const consumed = consumeQueuedTurn(runtime, { matchActiveSuperRun: true });
  expect(consumed?.dequeuedBatch.items).toHaveLength(2);

  await Promise.resolve();
  const updates = socket.sentPayloads
    .map((payload) => JSON.parse(payload))
    .filter((payload) => payload.type === "update_queue");
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
    queue: [],
    removed: [
      { client_message_id: "cm-1", disposition: "dequeued" },
      { client_message_id: "cm-2", disposition: "dequeued" },
    ],
  });
});

test("explicit queue removal emits cancellation rather than dequeue", async () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conv-1",
  );
  const socket = new MockSocket();
  listener.socket = socket as unknown as WebSocket;

  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-cancel"))).toBe(
    true,
  );
  const item = runtime.queueRuntime.peek()[0];
  expect(item).toBeDefined();
  runtime.queueRuntime.removeItem(item?.id ?? "missing");

  await Promise.resolve();
  const update = socket.sentPayloads
    .map((payload) => JSON.parse(payload))
    .find((payload) => payload.type === "update_queue");
  expect(update).toMatchObject({
    queue: [],
    removed: [{ client_message_id: "cm-cancel", disposition: "cancelled" }],
  });
});
