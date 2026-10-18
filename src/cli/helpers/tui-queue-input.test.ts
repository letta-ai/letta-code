import { describe, expect, test } from "bun:test";
import {
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import {
  tuiQueuedClientPreferences,
  tuiSubmitClientPreferences,
} from "./tui-client-preferences";
import { prepareTuiQueueSubmit, toTuiQueuedMessage } from "./tui-queue-input";

describe("TUI queued input origins", () => {
  for (const source of ["user", "cron"] as const) {
    test(`${source} keeps its origin for idle dispatch and mid-turn append`, () => {
      const queue = new QueueRuntime();
      const message: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
        kind: "message",
        source,
        content: "prompt",
      };
      const item = queue.enqueue(message);
      if (!item || item.kind !== "message") throw new Error("Missing message");
      const queued = toTuiQueuedMessage(item);
      const batch = queue.consumeItems(1);
      if (!batch) throw new Error("Missing batch");
      const submit = prepareTuiQueueSubmit(batch);
      expect(submit.text).toBe("prompt");
      expect(submit.content).toEqual([{ type: "text", text: "prompt" }]);
      expect(submit.submitOptions.userInitiated).toBe(source === "user");
      expect(tuiSubmitClientPreferences(false, submit.submitOptions)).toEqual(
        source === "user" ? {} : undefined,
      );
      expect(tuiQueuedClientPreferences([queued])).toEqual(
        source === "user" ? {} : undefined,
      );
      expect(queued.queueItemId).toBe(item.id);
    });
  }

  test("task notification rich content survives without becoming human input", () => {
    const queue = new QueueRuntime();
    const notification: Omit<TaskNotificationQueueItem, "id" | "enqueuedAt"> = {
      kind: "task_notification",
      source: "task_notification",
      text: "<task-notification>done</task-notification>",
      content: [{ type: "text", text: "result" }],
    };
    const item = queue.enqueue(notification);
    if (!item || item.kind !== "task_notification")
      throw new Error("Missing task");
    const queued = toTuiQueuedMessage(item);
    const batch = queue.consumeItems(1);
    if (!batch) throw new Error("Missing batch");
    const submit = prepareTuiQueueSubmit(batch);
    expect(submit.submitOptions.userInitiated).toBe(false);
    expect(submit.text).toBe(item.text);
    expect(JSON.stringify(submit.content)).toContain("result");
    expect(queued.content).toEqual(item.content);
    expect(tuiQueuedClientPreferences([queued])).toBeUndefined();
  });

  test("human input takes precedence in a mixed scheduled batch", () => {
    const queue = new QueueRuntime();
    const messages: Omit<MessageQueueItem, "id" | "enqueuedAt">[] = [
      { kind: "message", source: "cron", content: "scheduled" },
      { kind: "message", source: "user", content: "human" },
    ];
    for (const message of messages) queue.enqueue(message);
    const batch = queue.consumeItems(2);
    if (!batch) throw new Error("Missing batch");
    const submit = prepareTuiQueueSubmit(batch);
    expect(submit.text).toBe("scheduled\nhuman");
    expect(submit.submitOptions.userInitiated).toBe(true);
  });
});
