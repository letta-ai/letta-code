import { expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { TaskNotificationQueueItem } from "@/queue/queue-runtime";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";

test("preserves every input message and author across queue entries", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-a",
    "conv-a",
  );
  const scope = { agentId: "agent-a", conversationId: "conv-a" };
  const first = [
    {
      role: "user",
      content: "first",
      otid: "one",
      client_message_id: "cm-one",
      attribution: { acting_user_id: "human-a" },
    },
    {
      role: "user",
      content: "second",
      otid: "two",
      client_message_id: "cm-two",
      attribution: {},
    },
  ] satisfies Array<
    MessageCreate & {
      client_message_id: string;
      attribution: { acting_user_id?: string };
    }
  >;
  const third = {
    role: "user",
    content: "third",
    otid: "three",
    client_message_id: "cm-three",
    attribution: { acting_user_id: "human-b" },
  } satisfies MessageCreate & {
    client_message_id: string;
    attribution: { acting_user_id?: string };
  };
  enqueueInboundUserMessage(
    runtime,
    { type: "message", ...scope, messages: first },
    "human-a",
    "assertion-a",
  );
  enqueueInboundUserMessage(
    runtime,
    { type: "message", ...scope, messages: [third] },
    "human-b",
    "assertion-b",
  );
  const ids = runtime.queueRuntime.peek().map((item) => item.id);
  const consumed = consumeQueuedTurn(runtime);
  expect(consumed?.queuedTurn.messages).toEqual(first);
  expect(consumed?.queuedTurn.actingUserId).toBe("human-a");
  expect(consumed?.queuedTurn.actingUserAssertion).toBe("assertion-a");
  expect(consumed?.dequeuedBatch.items.map((item) => item.id)).toEqual(
    ids.slice(0, 1),
  );
  expect(
    runtime.dequeuedClientMessageIdsByBatchId.get(
      consumed?.dequeuedBatch.batchId ?? "",
    ),
  ).toEqual(["cm-one", "cm-two"]);

  const next = consumeQueuedTurn(runtime);
  expect(next?.queuedTurn.messages).toEqual([third]);
  expect(next?.queuedTurn.actingUserId).toBe("human-b");
  expect(next?.queuedTurn.actingUserAssertion).toBe("assertion-b");
  expect(runtime.queueRuntime.length).toBe(0);
});

test("a principal reminder never blocks later human steering", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-a",
    "conv-a",
  );
  runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  const reminder = {
    role: "user",
    content: "scheduled reminder",
    attribution: {},
  } satisfies MessageCreate & { attribution: object };
  enqueueInboundUserMessage(runtime, {
    type: "message",
    agentId: "agent-a",
    conversationId: "conv-a",
    messages: [reminder],
  });
  enqueueInboundUserMessage(
    runtime,
    {
      type: "message",
      agentId: "agent-a",
      conversationId: "conv-a",
      messages: [{ role: "user", content: "steer" }],
    },
    "human-b",
    "assertion-b",
  );
  const consumed = consumeQueuedTurn(runtime);
  expect(consumed?.queuedTurn.messages).toEqual([
    reminder,
    {
      role: "user",
      content: "steer",
      attribution: { acting_user_id: "human-b" },
    },
  ]);
  expect(consumed?.queuedTurn.actingUserId).toBe("human-b");
  expect(consumed?.queuedTurn.actingUserAssertion).toBe("assertion-b");
  expect(runtime.queueRuntime.length).toBe(0);
});

test("mixed-owner background notifications keep separate authority", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-a",
    "conv-a",
  );
  for (const actingUserId of ["human-a", "human-b", undefined]) {
    const item: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
      kind: "task_notification",
      source: "task_notification",
      agentId: "agent-a",
      conversationId: "conv-a",
      text: "completed",
      actingUserId,
    };
    runtime.queueRuntime.enqueue(item);
  }
  const first = consumeQueuedTurn(runtime);
  expect(first?.queuedTurn.messages).toHaveLength(1);
  expect(first?.queuedTurn.actingUserId).toBe("human-a");
  const second = consumeQueuedTurn(runtime);
  expect(second?.queuedTurn.messages).toHaveLength(2);
  expect(second?.queuedTurn.actingUserId).toBe("human-b");
  for (const message of [
    ...(first?.queuedTurn.messages ?? []),
    ...(second?.queuedTurn.messages ?? []),
  ]) {
    expect(message).toMatchObject({
      role: "user",
      content: "completed",
      attribution: {},
    });
  }
  expect(runtime.queueRuntime.length).toBe(0);
});

test("same-owner background notifications keep their acting user", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-a",
    "conv-a",
  );
  for (const text of ["event", "completed"]) {
    const item: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
      kind: "task_notification",
      source: "task_notification",
      agentId: "agent-a",
      conversationId: "conv-a",
      text,
      actingUserId: "human-a",
    };
    runtime.queueRuntime.enqueue(item);
  }
  const consumed = consumeQueuedTurn(runtime);
  expect(consumed?.queuedTurn.actingUserId).toBe("human-a");
  expect(consumed?.queuedTurn.messages).toHaveLength(2);
  for (const message of consumed?.queuedTurn.messages ?? []) {
    expect(message).toMatchObject({ attribution: {} });
  }
  expect(runtime.queueRuntime.length).toBe(0);
});

test("same-author messages stay separate and paused messages stay parked", () => {
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-a",
    "conv-a",
  );
  const incoming = (content: string) => ({
    type: "message" as const,
    agentId: "agent-a",
    conversationId: "conv-a",
    messages: [{ role: "user" as const, content, otid: content }],
  });
  enqueueInboundUserMessage(
    runtime,
    incoming("first"),
    "human-a",
    "assertion-a-1",
  );
  enqueueInboundUserMessage(
    runtime,
    incoming("second"),
    "human-a",
    "assertion-a-2",
  );
  const batch = consumeQueuedTurn(runtime);
  expect(batch?.queuedTurn.messages).toHaveLength(2);
  expect(batch?.queuedTurn.actingUserId).toBe("human-a");
  expect(batch?.queuedTurn.actingUserAssertion).toBe("assertion-a-1");
  expect(batch?.queuedTurn.messages.map((message) => message.otid)).toEqual([
    "first",
    "second",
  ]);
  enqueueInboundUserMessage(runtime, incoming("paused"), "human-a");
  runtime.queueRuntime.pause();
  const item: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
    kind: "task_notification",
    source: "task_notification",
    text: "completed",
    agentId: "agent-a",
    conversationId: "conv-a",
  };
  runtime.queueRuntime.enqueue(item);
  expect(consumeQueuedTurn(runtime)?.queuedTurn.messages).toHaveLength(1);
  expect(runtime.queueRuntime.length).toBe(1);
  expect(consumeQueuedTurn(runtime)).toBeNull();
  runtime.queueRuntime.resume();
  expect(consumeQueuedTurn(runtime)?.queuedTurn.messages[0]).toMatchObject({
    content: "paused",
    otid: "paused",
  });
});
