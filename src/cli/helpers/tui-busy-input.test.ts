import { describe, expect, test } from "bun:test";
import {
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import {
  hasTuiBusyInput,
  parkTuiBusyInput,
  takeTuiBusyInput,
} from "./tui-busy-input";

describe("parked unaccepted TUI input", () => {
  test("late notifications cannot overtake a paused recovered request", () => {
    const queue = new QueueRuntime();
    parkTuiBusyInput(queue, [
      { role: "user", content: "original", otid: "same-otid" },
    ]);
    const notification = queue.enqueue({
      kind: "task_notification",
      source: "system",
      text: "late notice",
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);
    if (!notification) throw new Error("Notification not queued");
    expect(queue.readyLength).toBe(0);
    expect(hasTuiBusyInput(queue)).toBe(false);
    expect(queue.tryDequeue(null)).toBeNull();
    queue.resume();
    expect(hasTuiBusyInput(queue)).toBe(true);
    expect(takeTuiBusyInput(queue)).toEqual([
      { role: "user", content: "original", otid: "same-otid" },
    ]);
    expect(queue.items).toEqual([notification]);
  });

  test("recovery preserves multiple user messages with optional SDK discriminators", () => {
    const queue = new QueueRuntime();
    const messages = [
      { role: "user" as const, content: "one", otid: "first" },
      { role: "user" as const, content: "two", otid: "second" },
    ];
    parkTuiBusyInput(queue, messages);
    queue.resume();
    expect(takeTuiBusyInput(queue)).toEqual(messages);
    expect(queue.length).toBe(0);
  });
  test("preserves exact payload and FIFO until explicit resume", () => {
    const queue = new QueueRuntime();
    const pending = queue.enqueue({
      kind: "message",
      source: "user",
      content: "later",
    } as Omit<MessageQueueItem, "id" | "enqueuedAt">);
    if (!pending) throw new Error("Message not queued");
    const notification = queue.enqueue({
      kind: "task_notification",
      source: "system",
      text: "notice",
    } as Omit<TaskNotificationQueueItem, "id" | "enqueuedAt">);
    if (!notification) throw new Error("Notification not queued");
    const message = {
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "text" as const, text: "original" }],
      otid: "original-otid",
    };
    parkTuiBusyInput(queue, [message]);
    expect(queue.items.slice(1)).toEqual([pending, notification]);
    expect(queue.readyLength).toBe(0);
    expect(takeTuiBusyInput(queue)).toBeNull();
    queue.resume();
    expect(takeTuiBusyInput(queue)?.[0]).toBe(message);
    expect(queue.items).toEqual([pending, notification]);
    expect(takeTuiBusyInput(queue)).toBeNull();
  });
  test("never replays tool results and can park only remaining inputs", () => {
    const queue = new QueueRuntime();
    const pending = queue.enqueue({
      kind: "message",
      source: "user",
      content: "later",
    } as Omit<MessageQueueItem, "id" | "enqueuedAt">);
    if (!pending) throw new Error("Message not queued");
    parkTuiBusyInput(queue, [
      { type: "approval", approvals: [], otid: "tool-result" },
    ]);
    expect(queue.items).toEqual([pending]);
    expect(queue.readyLength).toBe(0);
    queue.resume();
    expect(takeTuiBusyInput(queue)).toBeNull();
  });
});
