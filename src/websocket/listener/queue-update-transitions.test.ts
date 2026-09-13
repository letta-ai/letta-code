import { expect, test } from "bun:test";
import WebSocket from "ws";
import type { QueueMessage } from "@/types/protocol_v2";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { buildQueueSnapshot } from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import type { IncomingMessage } from "./types";

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

const reminder = "<system-reminder>internal context</system-reminder>";
const image = {
  type: "image" as const,
  source: { type: "url" as const, url: "https://example.com/image.png" },
};

for (const { name, messages, expected } of [
  {
    name: "system roles",
    messages: [{ role: "system", content: "Internal context" }],
    expected: [],
  },
  {
    name: "onboarding reminder strings",
    messages: [{ role: "user", content: reminder }],
    expected: [],
  },
  {
    name: "reminder-only parts",
    messages: [{ role: "user", content: [{ type: "text", text: reminder }] }],
    expected: [],
  },
  {
    name: "same-string reminder and user text",
    messages: [{ role: "user", content: `${reminder}\nhello${reminder}` }],
    expected: ["hello"],
  },
  {
    name: "mixed system and user batches",
    messages: [
      { role: "system", content: "Internal context" },
      { role: "user", content: reminder },
      { role: "user", content: `${reminder}hello` },
      { role: "user", content: [{ type: "text", text: "world" }, image] },
    ],
    expected: [
      [{ type: "text", text: "hello" }, { type: "text", text: "world" }, image],
    ],
  },
  {
    name: "attachments with reminders",
    messages: [
      { role: "user", content: [{ type: "text", text: reminder }, image] },
    ],
    expected: [[image]],
  },
  {
    name: "attachment-only messages",
    messages: [{ role: "user", content: [image] }],
    expected: [[image]],
  },
  {
    name: "same-part reminder and user text",
    messages: [
      { role: "user", content: [{ type: "text", text: `${reminder}hello` }] },
    ],
    expected: [[{ type: "text", text: "hello" }]],
  },
] satisfies Array<{
  name: string;
  messages: IncomingMessage["messages"];
  expected: QueueMessage["content"][];
}>) {
  test(`queue projection handles ${name} without changing delivery or removals`, async () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
      listener,
      "agent-1",
      "conv-1",
    );
    const socket = new MockSocket();
    listener.socket = socket as unknown as WebSocket;
    const incoming = { ...queuedMessage("cm-visible"), messages };
    const original = structuredClone(incoming);
    expect(enqueueInboundUserMessage(runtime, incoming)).toBe(true);
    const item = runtime.queueRuntime.items[0];
    if (!item) throw new Error("expected queued input");
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    expect(
      buildQueueSnapshot(listener, scope).map((row) => row.content),
    ).toEqual(expected);
    expect(runtime.queueRuntime.items).toHaveLength(1);
    expect(runtime.queuedMessagesByItemId.get(item.id)).toEqual(original);
    const consumed = consumeQueuedTurn(runtime);
    expect(consumed?.queuedTurn.messages).toEqual(
      original.messages.map((message, index) =>
        index === 0 &&
        "content" in message &&
        typeof message.content === "string"
          ? { ...message, content: [{ type: "text", text: message.content }] }
          : message,
      ),
    );
    await Promise.resolve();
    const update = socket.sentPayloads
      .map((payload) => JSON.parse(payload))
      .find((payload) => payload.type === "update_queue");
    expect(update).toMatchObject({
      queue: [],
      removed: [
        { client_message_id: item.clientMessageId, disposition: "dequeued" },
      ],
    });
  });
}

test("queue projection keeps notifications and handles message content without saved input", () => {
  const listener = __listenClientTestUtils.createListenerRuntime();
  const runtime = __listenClientTestUtils.getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conv-1",
  );
  for (const item of [
    { kind: "message", source: "user", content: reminder },
    { kind: "message", source: "user", content: `${reminder}hello` },
    { kind: "task_notification", source: "task_notification", text: reminder },
    {
      kind: "cron_prompt",
      source: "cron",
      text: reminder,
      cronTaskId: "cron-1",
    },
  ] as const) {
    runtime.queueRuntime.enqueue(item);
  }
  expect(
    buildQueueSnapshot(listener, {
      agent_id: "agent-1",
      conversation_id: "conv-1",
    }).map((row) => row.content),
  ).toEqual(["hello", reminder, reminder]);
  expect(runtime.queueRuntime.items).toHaveLength(4);
});

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
