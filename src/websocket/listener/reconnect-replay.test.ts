import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MessageQueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { recoverPendingQueuedMessages } from "./reconnect-replay";
import { clearConversationRuntimeState } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { StartListenerOptions } from "./types";

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

function createMockOpts(): StartListenerOptions {
  return {
    connectionId: "test-conn",
    wsUrl: "ws://localhost",
    deviceId: "device-1",
    connectionName: "test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  } as unknown as StartListenerOptions;
}

function enqueueMessage(
  runtime: ReturnType<typeof getOrCreateScopedRuntime>,
  text: string,
): void {
  runtime.queueRuntime.enqueue({
    kind: "message",
    source: "channel",
    agentId: runtime.agentId ?? undefined,
    conversationId: runtime.conversationId ?? undefined,
    content: [{ type: "text", text }],
  } as Omit<MessageQueueItem, "id" | "enqueuedAt">);
}

describe("recoverPendingQueuedMessages", () => {
  let listener: ReturnType<typeof createRuntime>;

  beforeEach(() => {
    listener = createRuntime();
  });

  afterEach(() => {
    for (const cr of listener.conversationRuntimes.values()) {
      clearConversationRuntimeState(cr);
    }
    listener.conversationRuntimes.clear();
  });

  test("schedules queue pumps for conversations with preserved items", () => {
    const socket = createOpenTransport();
    const opts = createMockOpts();
    const processQueuedTurn = async () => {};

    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");

    enqueueMessage(runtime, "preserved message");
    expect(runtime.queueRuntime.isEmpty).toBe(false);

    // Should schedule a pump for the preserved item
    recoverPendingQueuedMessages(listener, socket, opts, processQueuedTurn);

    // scheduleQueuePump sets queuePumpScheduled = true
    expect(runtime.queuePumpScheduled).toBe(true);
  });

  test("skips conversations with empty queues", () => {
    const socket = createOpenTransport();
    const opts = createMockOpts();
    const processQueuedTurn = async () => {};

    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");

    // Queue is empty by default
    expect(runtime.queueRuntime.isEmpty).toBe(true);

    recoverPendingQueuedMessages(listener, socket, opts, processQueuedTurn);

    // No pump should be scheduled for an empty queue
    expect(runtime.queuePumpScheduled).toBe(false);
  });

  test("schedules pumps for multiple conversations with preserved items", () => {
    const socket = createOpenTransport();
    const opts = createMockOpts();
    const processQueuedTurn = async () => {};

    const runtime1 = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const runtime2 = getOrCreateScopedRuntime(listener, "agent-2", "conv-2");

    enqueueMessage(runtime1, "message for conv-1");
    enqueueMessage(runtime2, "message for conv-2");

    recoverPendingQueuedMessages(listener, socket, opts, processQueuedTurn);

    expect(runtime1.queuePumpScheduled).toBe(true);
    expect(runtime2.queuePumpScheduled).toBe(true);
  });
});

describe("queue preservation on disconnect", () => {
  test("intentional shutdown clears the queue", () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");

    enqueueMessage(runtime, "queued before shutdown");
    expect(runtime.queueRuntime.length).toBe(1);

    // Simulate intentional shutdown
    listener.intentionallyClosed = true;
    for (const cr of listener.conversationRuntimes.values()) {
      cr.queuedMessagesByItemId.clear();
      if (cr.queueRuntime) {
        cr.queueRuntime.clear("shutdown");
      }
    }

    expect(runtime.queueRuntime.isEmpty).toBe(true);
  });

  test("unintentional disconnect preserves queued items for replay", () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");

    enqueueMessage(runtime, "queued before disconnect");
    expect(runtime.queueRuntime.length).toBe(1);

    // Simulate unintentional disconnect — do NOT clear the queue
    // (intentionallyClosed stays false)
    expect(listener.intentionallyClosed).toBe(false);

    // Queue should still have the item
    expect(runtime.queueRuntime.isEmpty).toBe(false);
    expect(runtime.queueRuntime.length).toBe(1);
  });
});
