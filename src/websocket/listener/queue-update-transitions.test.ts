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

function queuedMessage(...clientMessageIds: string[]) {
  return {
    type: "message" as const,
    agentId: "agent-1",
    conversationId: "conv-1",
    messages: clientMessageIds.map((clientMessageId) => ({
      role: "user" as const,
      content: clientMessageId,
      client_message_id: clientMessageId,
    })),
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

  expect(
    enqueueInboundUserMessage(runtime, queuedMessage("cm-1", "cm-1b")),
  ).toBe(true);
  expect(enqueueInboundUserMessage(runtime, queuedMessage("cm-2"))).toBe(true);
  const consumed = consumeQueuedTurn(runtime);
  expect(consumed?.dequeuedBatch.items).toHaveLength(2);
  expect(
    runtime.dequeuedClientMessageIdsByBatchId.get(
      consumed?.dequeuedBatch.batchId ?? "missing",
    ),
  ).toEqual(["cm-1", "cm-1b", "cm-2"]);

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

test("dequeue correlates the queue id generated for a payload without one", () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conv-1",
  );
  expect(
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "hello" }],
    }),
  ).toBe(true);
  const generatedClientMessageId =
    runtime.queueRuntime.peek()[0]?.clientMessageId;
  if (!generatedClientMessageId) {
    throw new Error("expected a generated client message id");
  }

  const consumed = consumeQueuedTurn(runtime);

  expect(generatedClientMessageId).toStartWith("cm-submit-");
  expect(
    runtime.dequeuedClientMessageIdsByBatchId.get(
      consumed?.dequeuedBatch.batchId ?? "missing",
    ),
  ).toEqual([generatedClientMessageId]);
});
