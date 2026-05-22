import { describe, expect, mock, test } from "bun:test";
import type { NotificationBuffer } from "@/utils/task-notifications";
import { appendTaskNotificationEventsToBuffer } from "@/utils/task-notifications";

// ---------------------------------------------------------------------------
// Helper-level behavioral tests
// ---------------------------------------------------------------------------

describe("appendTaskNotificationEventsToBuffer", () => {
  const makeBuffer = (): NotificationBuffer => ({
    byId: new Map(),
    order: [],
  });

  let idCounter = 0;
  const generateId = () => `event_${++idCounter}`;

  test("writes events to buffer and calls flush", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    const result = appendTaskNotificationEventsToBuffer(
      ["Agent completed", "Reflection done"],
      buffer,
      generateId,
      flush,
    );

    expect(result).toBe(true);
    expect(buffer.order).toHaveLength(2);
    expect(buffer.byId.size).toBe(2);
    expect(flush).toHaveBeenCalledTimes(1);

    // Verify event shape
    const firstId = buffer.order[0];
    expect(firstId).toBeDefined();
    const first = buffer.byId.get(firstId as string) as Record<string, unknown>;
    expect(first.kind).toBe("event");
    expect(first.eventType).toBe("task_notification");
    expect(first.phase).toBe("finished");
    expect(first.summary).toBe("Agent completed");
  });

  test("flush is called exactly once even with multiple summaries", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    appendTaskNotificationEventsToBuffer(
      ["one", "two", "three"],
      buffer,
      generateId,
      flush,
    );

    expect(buffer.order).toHaveLength(3);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  test("returns false and skips flush for empty summaries", () => {
    const buffer = makeBuffer();
    const flush = mock(() => {});

    const result = appendTaskNotificationEventsToBuffer(
      [],
      buffer,
      generateId,
      flush,
    );

    expect(result).toBe(false);
    expect(buffer.order).toHaveLength(0);
    expect(flush).not.toHaveBeenCalled();
  });

  test("works without flush callback (non-background caller)", () => {
    const buffer = makeBuffer();

    const result = appendTaskNotificationEventsToBuffer(
      ["Agent completed"],
      buffer,
      generateId,
    );

    expect(result).toBe(true);
    expect(buffer.order).toHaveLength(1);
  });
});
