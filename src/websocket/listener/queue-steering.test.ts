import { afterEach, describe, expect, test } from "bun:test";
import type WebSocket from "ws";
import type {
  MessageQueueItem,
  TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import type { SteerQueueItemCommand } from "@/types/queue-update-protocol";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import { parseServerMessage } from "./protocol-inbound";
import { consumeQueuedTurn, scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

const scope = { agent_id: "agent-queue", conversation_id: "conv-queue" };
const opts: StartListenerOptions = {
  connectionId: "conn-queue",
  wsUrl: "ws://test",
  deviceId: "device-test",
  connectionName: "queue-test",
  onConnected() {},
  onDisconnected() {},
  onError() {},
};

function fixture() {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const sent: unknown[] = [];
  const socket = {
    readyState: 1,
    send(payload: string) {
      sent.push(JSON.parse(payload));
    },
  } as unknown as WebSocket;
  listener.socket = socket;
  setActiveRuntime(listener);
  const processed: IncomingMessage[] = [];
  const processQueuedTurn = async (incoming: IncomingMessage) => {
    processed.push(incoming);
  };
  const handler = createListenerMessageHandler({
    runtime: listener,
    socket,
    opts,
    processQueuedTurn,
    fileCommandSession: { handle: () => false },
    getParsedRuntimeScope: () => null,
    replaySyncStateForRuntime: async () => {},
    getOrCreateScopedRuntime,
    handleApprovalResponseInput: async () => false,
    handleChangeDeviceStateInput: async () => false,
    handleAbortMessageInput: async () => false,
    stampInboundUserMessageOtids: (incoming) => incoming,
    safeSocketSend: (_socket, payload) => {
      sent.push(payload);
      return true;
    },
    runDetachedListenerTask: () => {},
    trackListenerError: () => {},
    processIncomingMessage: async () => {},
  });
  const enqueue = (text: string) => {
    const incoming: IncomingMessage = {
      type: "message",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages: [
        {
          role: "user",
          content: text,
          otid: `otid-${text}`,
          client_message_id: `cm-${text}`,
        },
      ],
    };
    expect(enqueueInboundUserMessage(runtime, incoming, `author-${text}`)).toBe(
      true,
    );
    const id = runtime.queueRuntime.items.at(-1)?.id;
    if (!id) throw new Error("Queue rejected input");
    return id;
  };
  const steer = async (itemId: string, targetScope = scope) => {
    const command: SteerQueueItemCommand = {
      type: "steer_queue_item",
      runtime: targetScope,
      request_id: `steer-${itemId}`,
      item_id: itemId,
    };
    await handler(Buffer.from(JSON.stringify(command)));
    await runtime.messageQueue;
  };
  return {
    listener,
    runtime,
    socket,
    sent,
    processed,
    processQueuedTurn,
    enqueue,
    steer,
  };
}

afterEach(() => setActiveRuntime(null));

describe("queue steering protocol", () => {
  test("validates the scoped per-item command", () => {
    const command: SteerQueueItemCommand = {
      type: "steer_queue_item",
      runtime: scope,
      request_id: "r-1",
      item_id: "q-1",
    };
    expect(parseServerMessage(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
    for (const change of [
      { item_id: undefined },
      { item_id: "" },
      { item_id: 1 },
      { runtime: undefined },
      { request_id: undefined },
    ]) {
      expect(
        parseServerMessage(
          Buffer.from(JSON.stringify({ ...command, ...change })),
        ),
      ).toBeNull();
    }
  });

  test("one selected message joins the active turn; alerts pass unselected user messages", async () => {
    const f = fixture();
    const lease = f.runtime.turnLifecycle.begin({
      origin: "message",
      initialStatus: "PROCESSING_API_RESPONSE",
      workingDirectory: process.cwd(),
    });
    const first = f.enqueue("first");
    const selected = f.enqueue("selected");
    f.runtime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: "alert",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);
    const alerts = consumeQueuedTurn(f.runtime, "steering");
    expect(alerts?.queuedTurn.messages).toEqual([
      expect.objectContaining({ content: "alert", attribution: {} }),
    ]);
    expect(f.runtime.queueRuntime.items.map((item) => item.id)).toEqual([
      first,
      selected,
    ]);

    await f.steer(selected);
    expect(f.processed).toHaveLength(0);
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "steer_queue_item_response",
        request_id: `steer-${selected}`,
        item_id: selected,
        success: true,
        runtime: scope,
      }),
    );
    const batch = consumeQueuedTurn(f.runtime, "steering");
    expect(batch?.dequeuedBatch.items.map((item) => item.id)).toEqual([
      selected,
    ]);
    expect(batch?.queuedTurn.messages).toEqual([
      expect.objectContaining({
        content: "selected",
        otid: "otid-selected",
        attribution: { acting_user_id: "author-selected" },
      }),
    ]);
    expect(
      f.runtime.dequeuedClientMessageIdsByBatchId.get(
        batch?.dequeuedBatch.batchId ?? "",
      ),
    ).toEqual(["cm-selected"]);
    expect(f.runtime.queuedMessagesByItemId.has(first)).toBe(true);
    expect(consumeQueuedTurn(f.runtime, "steering")).toBeNull();

    await f.steer(selected);
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "steer_queue_item_response",
        success: false,
      }),
    );
    f.runtime.turnLifecycle.finish(lease, "end_turn");
    scheduleQueuePump(f.runtime, f.socket, opts, f.processQueuedTurn);
    await f.runtime.messageQueue;
    expect(f.processed).toHaveLength(1);
    expect(f.processed[0]?.messages).toEqual([
      expect.objectContaining({ content: "first" }),
    ]);
    expect(f.runtime.queueRuntime.length).toBe(0);
  });

  test("preserves multimodal content and every message in the selected input", () => {
    const f = fixture();
    f.enqueue("waiting");
    const messages: IncomingMessage["messages"] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: { type: "url", url: "https://example.test/image.png" },
          },
        ],
        otid: "image-otid",
        client_message_id: "image-client",
      },
      {
        role: "user",
        content: "also this",
        otid: "text-otid",
        client_message_id: "text-client",
      },
    ];
    enqueueInboundUserMessage(f.runtime, {
      type: "message",
      agentId: scope.agent_id,
      conversationId: scope.conversation_id,
      messages,
    });
    const selected = f.runtime.queueRuntime.items.at(-1)?.id ?? "";
    expect(f.runtime.queueRuntime.steer(selected)).toBe(true);
    const batch = consumeQueuedTurn(f.runtime, "steering");
    expect(
      batch?.queuedTurn.messages.map((message) =>
        "content" in message ? message.content : null,
      ),
    ).toEqual(
      messages.map((message) =>
        "content" in message ? message.content : null,
      ),
    );
    expect(
      f.runtime.dequeuedClientMessageIdsByBatchId.get(
        batch?.dequeuedBatch.batchId ?? "",
      ),
    ).toEqual(["image-client", "text-client"]);
    expect(f.runtime.queueRuntime.length).toBe(1);
  });

  test("a selected paused item starts alone if the active turn already ended", async () => {
    const f = fixture();
    const first = f.enqueue("first");
    const selected = f.enqueue("selected");
    f.runtime.queueRuntime.pause();
    await f.steer(selected);
    expect(f.processed).toHaveLength(1);
    expect(f.processed[0]?.messages).toEqual([
      expect.objectContaining({ content: "selected" }),
    ]);
    expect(f.runtime.queueRuntime.items).toEqual([
      expect.objectContaining({ id: first, paused: true }),
    ]);
  });

  test("an end-turn race does not bundle unrelated follow-ups with the selected item", () => {
    const f = fixture();
    f.enqueue("first");
    const selected = f.enqueue("selected");
    f.enqueue("last");
    f.runtime.queueRuntime.steer(selected);
    const batch = consumeQueuedTurn(f.runtime);
    expect(batch?.queuedTurn.messages).toEqual([
      expect.objectContaining({ content: "selected" }),
    ]);
    expect(f.runtime.queueRuntime.items).toHaveLength(2);
  });

  test("controls cannot select an item in another conversation", async () => {
    const f = fixture();
    const selected = f.enqueue("selected");
    await f.steer(selected, { ...scope, conversation_id: "other" });
    expect(f.sent).toContainEqual(
      expect.objectContaining({
        type: "steer_queue_item_response",
        success: false,
      }),
    );
    expect(
      (f.runtime.queueRuntime.items[0] as MessageQueueItem).steering,
    ).toBeUndefined();
    expect(f.processed).toHaveLength(0);
  });
});
