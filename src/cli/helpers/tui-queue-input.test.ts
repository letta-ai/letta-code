import { describe, expect, test } from "bun:test";
import {
  type MessageQueueItem,
  QueueRuntime,
  type TaskNotificationQueueItem,
} from "@/queue/queue-runtime";
import { parkTuiBusyInput } from "./tui-busy-input";
import {
  tuiQueuedClientPreferences,
  tuiSubmitClientPreferences,
} from "./tui-client-preferences";
import {
  prepareTuiQueueSubmit,
  submitTuiQueuedInput,
  toTuiQueuedMessage,
} from "./tui-queue-input";

describe("TUI queued input origins", () => {
  test("routes recovered input unchanged before later ordinary submits", async () => {
    const queue = new QueueRuntime();
    const pending: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "later",
    };
    queue.enqueue(pending);
    const original = {
      role: "user" as const,
      content: "original",
      otid: "stable-otid",
    };
    parkTuiBusyInput(queue, [original]);
    const calls: unknown[] = [];
    const handlers = {
      retry: async (input: unknown) => {
        calls.push(input);
      },
      submit: async (input: unknown) => {
        calls.push(input);
      },
    };
    await submitTuiQueuedInput(queue, handlers);
    expect(calls).toEqual([]);
    queue.resume();
    await submitTuiQueuedInput(queue, handlers);
    expect(calls).toEqual([[original]]);
    expect(queue.length).toBe(1);
    await submitTuiQueuedInput(queue, handlers);
    expect(calls[1]).toEqual({
      text: "later",
      content: [{ type: "text", text: "later" }],
      submitOptions: { userInitiated: true },
    });
  });

  test("a failed recovered dispatch leaves later items unconsumed", async () => {
    const queue = new QueueRuntime();
    const pending: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content: "later",
    };
    queue.enqueue(pending);
    parkTuiBusyInput(queue, [
      { role: "user", content: "original", otid: "stable" },
    ]);
    queue.resume();
    await expect(
      submitTuiQueuedInput(queue, {
        retry: async (input) => {
          parkTuiBusyInput(queue, input);
          throw new Error("busy again");
        },
        submit: async () => {
          throw new Error("must not consume later input");
        },
      }),
    ).rejects.toThrow("busy again");
    expect(
      queue.items.map((item) => item.kind === "message" && item.content),
    ).toEqual(["original", "later"]);
    expect(queue.readyLength).toBe(0);
  });
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
