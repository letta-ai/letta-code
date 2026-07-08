import { afterEach, describe, expect, test } from "bun:test";
import type { MessageQueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import {
  clearConversationRuntimeState,
  clearStaleProcessingFlagIfIdle,
  setActiveRuntime,
} from "@/websocket/listener/runtime";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "@/websocket/listener/types";

function createLocalTransport(): {
  transport: ListenerTransport;
  sentPayloads: string[];
} {
  const sentPayloads: string[] = [];
  return {
    sentPayloads,
    transport: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: (data: string) => {
        sentPayloads.push(data);
      },
    },
  };
}

function createScopedRuntime(): ConversationRuntime {
  const listener = createRuntime();
  return getOrCreateScopedRuntime(listener, "agent-1", "default");
}

function createStartListenerOptions(): StartListenerOptions {
  return {
    connectionId: "conn-1",
    wsUrl: "ws://localhost/test",
    deviceId: "device-1",
    connectionName: "test-listener",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function enqueueUserMessage(
  runtime: ConversationRuntime,
  content: string,
): IncomingMessage {
  const queueItem: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
    kind: "message",
    source: "user",
    content,
    agentId: runtime.agentId ?? undefined,
    conversationId: runtime.conversationId,
  };
  const item = runtime.queueRuntime.enqueue(queueItem);
  if (!item) {
    throw new Error("failed to enqueue test message");
  }

  const incoming: IncomingMessage = {
    type: "message",
    agentId: runtime.agentId ?? undefined,
    conversationId: runtime.conversationId,
    messages: [{ role: "user", content }],
  };
  runtime.queuedMessagesByItemId.set(item.id, incoming);
  return incoming;
}

afterEach(() => {
  setActiveRuntime(null);
});

describe("listener conversation runtime cleanup", () => {
  test("clearConversationRuntimeState clears processing ownership and recovery flags", () => {
    const runtime = createScopedRuntime();
    const abortController = new AbortController();

    runtime.isProcessing = true;
    runtime.isRecoveringApprovals = true;
    runtime.loopStatus = "RETRYING_API_REQUEST";
    runtime.activeAbortController = abortController;
    runtime.activeRunId = "run-1";
    runtime.activeRunStartedAt = new Date().toISOString();
    runtime.activeWorkingDirectory = "/tmp/letta-test";
    runtime.activeExecutingToolCallIds = ["tool-1"];
    runtime.pendingApprovalBatchByToolCallId.set("tool-1", "approval-1");
    runtime.pendingInterruptedResults = [];
    runtime.pendingInterruptedContext = {
      agentId: "agent-1",
      conversationId: "default",
      continuationEpoch: runtime.continuationEpoch,
    };
    runtime.pendingInterruptedToolCallIds = ["tool-1"];
    runtime.pendingTurns = 1;
    runtime.queuePumpActive = true;
    runtime.queuePumpScheduled = true;

    clearConversationRuntimeState(runtime);

    expect(abortController.signal.aborted).toBe(true);
    expect(runtime.cancelRequested).toBe(true);
    expect(runtime.isProcessing).toBe(false);
    expect(runtime.isRecoveringApprovals).toBe(false);
    expect(runtime.loopStatus as string).toBe("WAITING_ON_INPUT");
    expect(runtime.activeWorkingDirectory).toBeNull();
    expect(runtime.activeRunId).toBeNull();
    expect(runtime.activeRunStartedAt).toBeNull();
    expect(runtime.activeAbortController).toBeNull();
    expect(runtime.activeExecutingToolCallIds).toEqual([]);
    expect(runtime.pendingApprovalBatchByToolCallId.size).toBe(0);
    expect(runtime.pendingInterruptedResults).toBeNull();
    expect(runtime.pendingInterruptedContext).toBeNull();
    expect(runtime.pendingInterruptedToolCallIds).toBeNull();
    expect(runtime.pendingTurns).toBe(0);
    expect(runtime.queuePumpActive).toBe(false);
    expect(runtime.queuePumpScheduled).toBe(false);
  });

  test("stale processing guard preserves active local work", () => {
    const runtime = createScopedRuntime();

    runtime.isProcessing = true;
    runtime.loopStatus = "WAITING_ON_INPUT";
    runtime.activeAbortController = new AbortController();
    runtime.activeRunId = "run-still-active";
    runtime.activeRunStartedAt = new Date().toISOString();

    const cleared = clearStaleProcessingFlagIfIdle(runtime, 0);

    expect(cleared).toBe(false);
    expect(runtime.isProcessing).toBe(true);
  });

  test("queue pump self-heals an idle split-brain processing flag and drains follow-up", async () => {
    const runtime = createScopedRuntime();
    const { transport } = createLocalTransport();
    setActiveRuntime(runtime.listener);
    enqueueUserMessage(runtime, "follow up after retry");

    runtime.isProcessing = true;
    runtime.isRecoveringApprovals = false;
    runtime.loopStatus = "WAITING_ON_INPUT";
    runtime.cancelRequested = false;
    runtime.activeWorkingDirectory = null;
    runtime.activeRunId = null;
    runtime.activeRunStartedAt = null;
    runtime.activeAbortController = null;
    runtime.activeExecutingToolCallIds = [];

    const processedTurns: IncomingMessage[] = [];
    scheduleQueuePump(
      runtime,
      transport,
      createStartListenerOptions(),
      async (queuedTurn) => {
        processedTurns.push(queuedTurn);
      },
    );

    await runtime.messageQueue;

    expect(runtime.isProcessing).toBe(false);
    expect(runtime.queueRuntime.length).toBe(0);
    expect(runtime.pendingTurns).toBe(0);
    expect(processedTurns).toHaveLength(1);
    expect(processedTurns[0]?.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "follow up after retry" }],
    });
  });

  test("cleanup path does not leave a runtime_busy gate after the interrupt latch is released", async () => {
    const runtime = createScopedRuntime();
    const { transport } = createLocalTransport();
    setActiveRuntime(runtime.listener);

    runtime.isProcessing = true;
    runtime.isRecoveringApprovals = true;
    runtime.loopStatus = "RETRYING_API_REQUEST";
    runtime.activeAbortController = new AbortController();
    runtime.activeRunId = "run-retry";
    runtime.activeRunStartedAt = new Date().toISOString();
    runtime.activeWorkingDirectory = "/tmp/letta-test";
    runtime.activeExecutingToolCallIds = ["tool-1"];

    clearConversationRuntimeState(runtime);
    runtime.cancelRequested = false;
    enqueueUserMessage(runtime, "follow up after cleanup");

    const processedTurns: IncomingMessage[] = [];
    scheduleQueuePump(
      runtime,
      transport,
      createStartListenerOptions(),
      async (queuedTurn) => {
        processedTurns.push(queuedTurn);
      },
    );

    await runtime.messageQueue;

    expect(runtime.isProcessing).toBe(false);
    expect(runtime.isRecoveringApprovals).toBe(false);
    expect(runtime.queueRuntime.length).toBe(0);
    expect(processedTurns).toHaveLength(1);
    expect(processedTurns[0]?.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "follow up after cleanup" }],
    });
  });
});
