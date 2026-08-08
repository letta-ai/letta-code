import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import WebSocket from "ws";
import type { TaskNotificationQueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
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
