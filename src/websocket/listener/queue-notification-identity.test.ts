import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import type { TaskNotificationQueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { emitDequeuedUserMessage } from "./protocol-outbound";
import { consumeQueuedTurn } from "./queue";
import { ensureTurnInputMessageOtids } from "./turn-input-state";

class MockSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

describe("queued notification identity", () => {
  test("assigns distinct stable OTIDs to visible payloads without IDs", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [
        { role: "user", content: "<system-reminder>hidden</system-reminder>" },
        { role: "user", content: "one" },
        { role: "user", content: "two" },
      ],
    });
    const consumed = consumeQueuedTurn(runtime);
    if (!consumed) throw new Error("Expected queued input");
    const socket = new MockSocket();
    emitDequeuedUserMessage(
      socket as never,
      runtime,
      consumed.queuedTurn,
      consumed.dequeuedBatch,
    );
    const deltas = socket.sentPayloads.map(
      (payload) => JSON.parse(payload).delta,
    );
    expect(deltas.map((delta) => delta.content)).toEqual(["one", "two"]);
    expect(new Set(deltas.map((delta) => delta.otid)).size).toBe(2);
    const prepared = ensureTurnInputMessageOtids(consumed.queuedTurn.messages);
    expect(prepared.slice(1).map((message) => message.otid)).toEqual(
      deltas.map((delta) => delta.otid),
    );
  });
  test("echoes every queued message with its own author and OTID", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      actingUserId: "human-a",
      messages: [
        {
          role: "user",
          content: "Alice",
          otid: "a",
          client_message_id: "cm-a",
          attribution: { acting_user_id: "human-a" },
        },
        {
          role: "user",
          content: "reminder",
          otid: "r",
          client_message_id: "cm-r",
          attribution: {},
        },
        {
          role: "user",
          content: "Bob",
          otid: "b",
          client_message_id: "cm-b",
          attribution: { acting_user_id: "human-b" },
        },
      ],
    });
    const consumed = consumeQueuedTurn(runtime);
    if (!consumed) throw new Error("Expected queued input");
    const socket = new MockSocket();
    emitDequeuedUserMessage(
      socket as never,
      runtime,
      consumed.queuedTurn,
      consumed.dequeuedBatch,
    );
    const deltas = socket.sentPayloads.map(
      (payload) => JSON.parse(payload).delta,
    );
    expect(
      deltas.map((delta) => [delta.content, delta.otid, delta.created_by_id]),
    ).toEqual([
      ["Alice", "a", "human-a"],
      ["reminder", "r", undefined],
      ["Bob", "b", "human-b"],
    ]);
    expect(
      runtime.dequeuedClientMessageIdsByBatchId.get(
        consumed.dequeuedBatch.batchId,
      ),
    ).toEqual(["cm-a", "cm-r", "cm-b"]);
  });
  test("preserves one OTID through optimistic echo and turn preparation", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-1",
      "conv-1",
    );
    runtime.queueRuntime.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: "<task-notification>done</task-notification>",
      agentId: "agent-1",
      conversationId: "conv-1",
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);

    const consumed = consumeQueuedTurn(runtime);
    const message = consumed?.queuedTurn.messages[0] as
      | MessageCreate
      | undefined;
    expect(message?.otid).toBeString();

    const socket = new MockSocket();
    if (consumed) {
      emitDequeuedUserMessage(
        socket as never,
        runtime,
        consumed.queuedTurn,
        consumed.dequeuedBatch,
      );
    }
    expect(socket.sentPayloads).toHaveLength(1);
    const optimisticMessage = JSON.parse(socket.sentPayloads[0] ?? "{}");
    expect(optimisticMessage.delta?.otid).toBe(message?.otid);

    const prepared = ensureTurnInputMessageOtids(
      consumed?.queuedTurn.messages ?? [],
    );
    expect(prepared[0]?.otid).toBe(message?.otid);
  });
});
