import { describe, expect, expectTypeOf, test } from "bun:test";
import { type QueueItemInput, QueueRuntime } from "@/queue/queue-runtime";

describe("queue input variants", () => {
  test("accepts each kind's fields and assigns queue-owned metadata", () => {
    const queue = new QueueRuntime();
    const items = [
      queue.enqueue({
        kind: "message",
        source: "user",
        content: "hello",
        noCoalesce: true,
      }),
      queue.enqueue({
        kind: "task_notification",
        source: "task_notification",
        text: "task finished",
        content: [{ type: "text", text: "result" }],
        clientMessageIds: ["client-message"],
      }),
      queue.enqueue({
        kind: "cron_prompt",
        source: "cron",
        text: "scheduled prompt",
        cronTaskId: "scheduled-task",
      }),
      queue.enqueue({
        kind: "mod_continue",
        source: "system",
        text: "continue",
      }),
    ];

    expect(items).toMatchObject([
      { kind: "message", content: "hello", noCoalesce: true },
      { kind: "task_notification", clientMessageIds: ["client-message"] },
      { kind: "cron_prompt", cronTaskId: "scheduled-task" },
      { kind: "mod_continue", text: "continue" },
    ]);
    expect(new Set(items.map((item) => item?.id)).size).toBe(4);
    for (const item of items) {
      expect(item?.id).toMatch(/^q-\d+$/);
      expect(item?.enqueuedAt).toBeNumber();
    }
  });

  test("requires the fields belonging to the selected kind", () => {
    expectTypeOf<{
      kind: "message";
      source: "user";
      text: string;
    }>().not.toMatchTypeOf<QueueItemInput>();
    expectTypeOf<{
      kind: "cron_prompt";
      source: "cron";
      text: string;
    }>().not.toMatchTypeOf<QueueItemInput>();
    expectTypeOf<{
      kind: "mod_continue";
      source: "system";
      content: string;
    }>().not.toMatchTypeOf<QueueItemInput>();
  });
});
