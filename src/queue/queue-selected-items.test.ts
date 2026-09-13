import { expect, test } from "bun:test";
import { ok } from "node:assert";
import {
  type DequeuedBatch,
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "./queue-runtime";

test("selected dequeue preserves queue order and emits only consumed IDs", () => {
  const batches: DequeuedBatch[] = [];
  const queue = new QueueRuntime({
    callbacks: { onDequeued: (batch) => batches.push(batch) },
  });
  const [a, b, c, d] = ["a", "b", "c", "d"].map((text) =>
    queue.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text,
      clientMessageId: `client-${text}`,
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">),
  );
  ok(a && b && c && d);
  const result = queue.consumeSelectedItems(new Set([d.id, b.id, "missing"]));
  ok(result);
  expect(result.items).toEqual([b, d]);
  expect(result?.mergedCount).toBe(2);
  expect(result?.queueLenAfter).toBe(2);
  expect(batches).toEqual([result]);
  expect(queue.peek()).toEqual([a, c]);
  expect(queue.consumeItems(2)?.items).toEqual([a, c]);
  expect(queue.length).toBe(0);
});

test("selected dequeue never consumes paused items or emits empty batches", () => {
  const batches: DequeuedBatch[] = [];
  const queue = new QueueRuntime({
    callbacks: { onDequeued: (batch) => batches.push(batch) },
  });
  const paused = queue.enqueue({
    kind: "message",
    source: "user",
    content: "parked",
  } as Omit<MessageQueueItem, "id" | "enqueuedAt">);
  queue.pause();
  const ready = queue.enqueue({
    kind: "task_notification",
    source: "task_notification",
    text: "ready",
  } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);
  ok(paused && ready);
  expect(
    queue.consumeSelectedItems(new Set([paused.id, ready.id]))?.items,
  ).toEqual([ready]);
  expect(
    queue.consumeSelectedItems(new Set([paused.id, ready.id, "missing"])),
  ).toBeNull();
  expect(queue.consumeSelectedItems(new Set())).toBeNull();
  expect(batches).toHaveLength(1);
  expect(queue.peek()).toEqual([paused]);
  queue.resume();
  expect(queue.consumeSelectedItems(new Set([paused.id]))?.items).toEqual([
    paused,
  ]);
  expect(batches[1]?.batchId).not.toBe(batches[0]?.batchId);
});
