import { expect, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import type { IncomingMessage } from "./types";

function message(text: string, capability: string | null): IncomingMessage {
  return {
    type: "message",
    agentId: "agent",
    conversationId: "conv",
    githubWriteCapability: capability,
    noCoalesce: Boolean(capability),
    messages: [{ role: "user", content: text, client_message_id: text }],
  };
}

test("keeps two humans and an autonomous notification in separate authorized turns", () => {
  const runtime = getOrCreateScopedRuntime(createRuntime(), "agent", "conv");
  enqueueInboundUserMessage(
    runtime,
    message("alice-request", "alice"),
    "alice",
  );
  const notification = {
    kind: "task_notification" as const,
    source: "system" as const,
    text: "background result",
    agentId: "agent",
    conversationId: "conv",
  };
  runtime.queueRuntime.enqueue(notification);
  enqueueInboundUserMessage(runtime, message("bob-request", "bob"), "bob");
  const first = consumeQueuedTurn(runtime);
  const autonomous = consumeQueuedTurn(runtime);
  const third = consumeQueuedTurn(runtime);
  expect(first?.queuedTurn.githubWriteCapability).toBe("alice");
  expect(first?.dequeuedBatch.items).toHaveLength(1);
  expect(autonomous?.queuedTurn.githubWriteCapability).toBeUndefined();
  expect(third?.queuedTurn.githubWriteCapability).toBe("bob");
  expect(third?.dequeuedBatch.items).toHaveLength(1);
});

test("an approval continuation leaves the next human request queued", () => {
  const runtime = getOrCreateScopedRuntime(createRuntime(), "agent", "conv");
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp",
  });
  enqueueInboundUserMessage(
    runtime,
    message("human-request", "human"),
    "human",
  );
  expect(consumeQueuedTurn(runtime)).toBeNull();
  runtime.turnLifecycle.finish(lease, "end_turn");
  expect(consumeQueuedTurn(runtime)?.queuedTurn.githubWriteCapability).toBe(
    "human",
  );
});
