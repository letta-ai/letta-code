import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { ACTING_USER_ID_HEADER } from "@/agent/acting-user";
import { sendMessageStreamWithBackend } from "@/agent/message";
import type { Backend } from "@/backend";
import type { TaskNotificationQueueItem } from "@/queue/queue-runtime";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn, scheduleQueuePump } from "./queue";
import { getActiveRuntime, setActiveRuntime } from "./runtime";
import { LocalListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

function enqueueNotification(
  runtime: ConversationRuntime,
  text: string,
  actingUserId?: string,
): void {
  const item: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
    kind: "task_notification",
    source: "task_notification",
    text,
    agentId: "agent-parent",
    conversationId: "conv-parent",
    actingUserId,
  };
  runtime.queueRuntime.enqueue(item);
}

describe("listener queue acting-user attribution", () => {
  test("delayed completions drain into separate requests for their initiating users", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      "agent-parent",
      "conv-parent",
    );
    const previousRuntime = getActiveRuntime();
    setActiveRuntime(listener);
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    const requests: Array<{ userId?: string; body: unknown }> = [];
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: unknown,
        options?: { headers?: Record<string, string> },
      ) => {
        requests.push({
          userId: options?.headers?.[ACTING_USER_ID_HEADER],
          body,
        });
        return stream;
      },
    } as unknown as Backend;
    const preparedToolContext =
      await prepareToolExecutionContextForSpecificTools([], {
        runtimeContext: { actingUserId: "cloud-user-current-turn" },
      });
    const sendQueuedTurn = async (queuedTurn: IncomingMessage) => {
      await sendMessageStreamWithBackend(
        backend,
        "conv-parent",
        queuedTurn.messages,
        {
          streamTokens: true,
          background: true,
          skillSources: [],
          preparedToolContext,
          actingUserId: queuedTurn.actingUserId,
        },
      );
    };
    const socket = new LocalListenerTransport();
    const options: StartListenerOptions = {
      connectionId: "conn-test",
      wsUrl: "wss://example.test/ws",
      deviceId: "device-test",
      connectionName: "test-listener",
      onConnected: () => {},
      onDisconnected: () => {},
      onError: () => {},
    };

    try {
      enqueueNotification(runtime, "Agent A completed", "cloud-user-a");
      enqueueNotification(runtime, "Agent B completed", "cloud-user-b");
      scheduleQueuePump(runtime, socket, options, sendQueuedTurn);
      await runtime.messageQueue;
      expect(requests).toHaveLength(0);
      expect(runtime.queueRuntime.length).toBe(2);

      runtime.turnLifecycle.finish(lease, "end_turn");
      scheduleQueuePump(runtime, socket, options, sendQueuedTurn);
      await runtime.messageQueue;

      expect(requests.map((request) => request.userId)).toEqual([
        "cloud-user-a",
        "cloud-user-b",
      ]);
      expect(JSON.stringify(requests[0]?.body)).toContain("Agent A completed");
      expect(JSON.stringify(requests[0]?.body)).not.toContain(
        "Agent B completed",
      );
      expect(JSON.stringify(requests[1]?.body)).toContain("Agent B completed");
      expect(runtime.queueRuntime.length).toBe(0);
    } finally {
      setActiveRuntime(previousRuntime);
    }
  });

  test("a queued user message cannot absorb another user's notification", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-parent",
      "conv-parent",
    );
    enqueueInboundUserMessage(
      runtime,
      {
        type: "message",
        agentId: "agent-parent",
        conversationId: "conv-parent",
        messages: [{ role: "user", content: "Continue my work" }],
      },
      "cloud-user-b",
    );
    enqueueNotification(runtime, "Agent A completed", "cloud-user-a");

    const first = consumeQueuedTurn(runtime);
    expect(first?.dequeuedBatch.items).toHaveLength(1);
    expect(first?.queuedTurn.actingUserId).toBe("cloud-user-b");
    const second = consumeQueuedTurn(runtime);
    expect(second?.dequeuedBatch.items).toHaveLength(1);
    expect(second?.queuedTurn.actingUserId).toBe("cloud-user-a");
    expect(consumeQueuedTurn(runtime)).toBeNull();
  });

  test.each([
    ["same-user", ["cloud-user-a", "cloud-user-a"], "cloud-user-a"],
    ["unattributed", [undefined, undefined], undefined],
    [
      "partly attributed",
      [undefined, "cloud-user-a", undefined],
      "cloud-user-a",
    ],
  ] as const)(
    "preserves %s notification coalescing",
    (_name, users, expectedUser) => {
      const runtime = getOrCreateScopedRuntime(
        createRuntime(),
        "agent-parent",
        "conv-parent",
      );
      for (const [index, user] of users.entries()) {
        enqueueNotification(runtime, `completed ${index}`, user);
      }
      const batch = consumeQueuedTurn(runtime);
      expect(batch?.dequeuedBatch.items).toHaveLength(users.length);
      expect(batch?.queuedTurn.actingUserId).toBe(expectedUser);
      expect(consumeQueuedTurn(runtime)).toBeNull();
    },
  );

  test("unattributed items do not bridge different acting users", () => {
    const runtime = getOrCreateScopedRuntime(
      createRuntime(),
      "agent-parent",
      "conv-parent",
    );
    for (const user of [undefined, "cloud-user-a", undefined, "cloud-user-b"]) {
      enqueueNotification(runtime, "completed", user);
    }
    const first = consumeQueuedTurn(runtime);
    expect(first?.dequeuedBatch.items).toHaveLength(3);
    expect(first?.queuedTurn.actingUserId).toBe("cloud-user-a");
    const second = consumeQueuedTurn(runtime);
    expect(second?.dequeuedBatch.items).toHaveLength(1);
    expect(second?.queuedTurn.actingUserId).toBe("cloud-user-b");
  });
});
