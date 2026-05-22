import { describe, expect, test } from "bun:test";
import type { QueueItem } from "@/queue/queue-runtime";
import { pickBatchActingUserId } from "@/websocket/listener/queue";

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "item-1",
    kind: "message",
    source: "user",
    content: "hi",
    enqueuedAt: 0,
    ...overrides,
  } as QueueItem;
}

describe("pickBatchActingUserId", () => {
  test("returns undefined when no item carries an actingUserId", () => {
    const items: QueueItem[] = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    expect(pickBatchActingUserId(items)).toBeUndefined();
  });

  test("returns the only acting user when present once", () => {
    const items: QueueItem[] = [
      makeItem({ id: "a", actingUserId: "user-1" }),
      makeItem({ id: "b" }),
    ];
    expect(pickBatchActingUserId(items)).toBe("user-1");
  });

  test("returns the LAST enqueued sender when the batch coalesces multiple users", () => {
    // Multi-user sandbox: user A and user B both sent messages that
    // coalesced into one turn. Cloud-api will be told the spend is on
    // user B (most recent), matching "whoever just pressed send pays".
    const items: QueueItem[] = [
      makeItem({ id: "a", actingUserId: "user-A" }),
      makeItem({ id: "b", actingUserId: "user-B" }),
    ];
    expect(pickBatchActingUserId(items)).toBe("user-B");
  });

  test("skips trailing items without actingUserId", () => {
    // A user-bearing item enqueued earlier should still attribute the
    // batch even if a tail notification has no actingUserId.
    const items: QueueItem[] = [
      makeItem({ id: "a", actingUserId: "user-A" }),
      makeItem({
        id: "b",
        kind: "task_notification",
        text: "ping",
      } as QueueItem),
    ];
    expect(pickBatchActingUserId(items)).toBe("user-A");
  });
});
