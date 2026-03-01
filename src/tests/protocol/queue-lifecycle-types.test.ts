import { describe, expect, test } from "bun:test";
import type {
  QueueBatchDequeuedEvent,
  QueueBlockedEvent,
  QueueBlockedReason,
  QueueClearedEvent,
  QueueClearedReason,
  QueueItemDroppedEvent,
  QueueItemDroppedReason,
  QueueItemEnqueuedEvent,
  QueueItemKind,
  QueueItemSource,
  QueueLifecycleEvent,
  WireMessage,
} from "../../types/protocol";

/**
 * Wire-shape tests for queue lifecycle protocol events.
 * These verify that each event type has the expected fields and
 * discriminant values, ensuring the protocol contract is stable.
 */

describe("QueueItemEnqueuedEvent wire shape", () => {
  test("has required fields with correct types", () => {
    const event: QueueItemEnqueuedEvent = {
      type: "queue_item_enqueued",
      item_id: "item-1",
      client_message_id: "cm-item-1",
      source: "user",
      kind: "message",
      queue_len: 1,
      session_id: "session-abc",
      uuid: "uuid-123",
    };

    expect(event.type).toBe("queue_item_enqueued");
    expect(event.item_id).toBe("item-1");
    expect(event.source).toBe("user");
    expect(event.kind).toBe("message");
    expect(event.queue_len).toBe(1);
    expect(event.session_id).toBe("session-abc");
    expect(event.uuid).toBe("uuid-123");
  });

  test("source covers all item origins", () => {
    const sources: Record<QueueItemSource, true> = {
      user: true,
      task_notification: true,
      subagent: true,
      system: true,
    } satisfies Record<QueueItemSource, true>;
    expect(Object.keys(sources)).toHaveLength(4);
  });

  test("kind covers all content types", () => {
    const kinds: Record<QueueItemKind, true> = {
      message: true,
      task_notification: true,
      approval_result: true,
      overlay_action: true,
    } satisfies Record<QueueItemKind, true>;
    expect(Object.keys(kinds)).toHaveLength(4);
  });
});

describe("QueueBatchDequeuedEvent wire shape", () => {
  test("has required fields with correct types", () => {
    const event: QueueBatchDequeuedEvent = {
      type: "queue_batch_dequeued",
      batch_id: "batch-1",
      item_ids: ["item-1", "item-2"],
      merged_count: 2,
      queue_len_after: 0,
      session_id: "session-abc",
      uuid: "uuid-456",
    };

    expect(event.type).toBe("queue_batch_dequeued");
    expect(event.batch_id).toBe("batch-1");
    expect(event.item_ids).toEqual(["item-1", "item-2"]);
    expect(event.merged_count).toBe(2);
    expect(event.queue_len_after).toBe(0);
  });

  test("single-item batch has merged_count 1", () => {
    const event: QueueBatchDequeuedEvent = {
      type: "queue_batch_dequeued",
      batch_id: "batch-2",
      item_ids: ["item-1"],
      merged_count: 1,
      queue_len_after: 3,
      session_id: "s",
      uuid: "u",
    };

    expect(event.merged_count).toBe(1);
    expect(event.item_ids).toHaveLength(1);
  });
});

describe("QueueBlockedEvent wire shape", () => {
  test("has required fields with correct types", () => {
    const event: QueueBlockedEvent = {
      type: "queue_blocked",
      reason: "streaming",
      queue_len: 2,
      session_id: "session-abc",
      uuid: "uuid-789",
    };

    expect(event.type).toBe("queue_blocked");
    expect(event.reason).toBe("streaming");
    expect(event.queue_len).toBe(2);
  });

  test("reason covers all blocked states", () => {
    const reasons: Record<QueueBlockedReason, true> = {
      streaming: true,
      pending_approvals: true,
      overlay_open: true,
      command_running: true,
      interrupt_in_progress: true,
      runtime_busy: true,
    } satisfies Record<QueueBlockedReason, true>;
    expect(Object.keys(reasons)).toHaveLength(6);
  });
});

describe("QueueClearedEvent wire shape", () => {
  test("has required fields with correct types", () => {
    const event: QueueClearedEvent = {
      type: "queue_cleared",
      reason: "processed",
      cleared_count: 3,
      session_id: "session-abc",
      uuid: "uuid-012",
    };

    expect(event.type).toBe("queue_cleared");
    expect(event.reason).toBe("processed");
    expect(event.cleared_count).toBe(3);
  });

  test("reason covers all terminal conditions", () => {
    const reasons: Record<QueueClearedReason, true> = {
      processed: true,
      error: true,
      cancelled: true,
      shutdown: true,
      stale_generation: true,
    } satisfies Record<QueueClearedReason, true>;
    expect(Object.keys(reasons)).toHaveLength(5);
  });
});

describe("QueueItemDroppedEvent wire shape", () => {
  test("has required fields with correct types", () => {
    const event: QueueItemDroppedEvent = {
      type: "queue_item_dropped",
      item_id: "item-99",
      reason: "buffer_limit",
      queue_len: 10,
      session_id: "session-abc",
      uuid: "uuid-345",
    };

    expect(event.type).toBe("queue_item_dropped");
    expect(event.item_id).toBe("item-99");
    expect(event.reason).toBe("buffer_limit");
    expect(event.queue_len).toBe(10);
  });

  test("reason covers all drop causes", () => {
    const reasons: Record<QueueItemDroppedReason, true> = {
      buffer_limit: true,
      stale_generation: true,
    } satisfies Record<QueueItemDroppedReason, true>;
    expect(Object.keys(reasons)).toHaveLength(2);
  });
});

describe("QueueLifecycleEvent union", () => {
  test("discriminates on type field", () => {
    const events: QueueLifecycleEvent[] = [
      {
        type: "queue_item_enqueued",
        item_id: "i1",
        client_message_id: "cm-i1",
        source: "user",
        kind: "message",
        queue_len: 1,
        session_id: "s",
        uuid: "u",
      },
      {
        type: "queue_batch_dequeued",
        batch_id: "b1",
        item_ids: ["i1"],
        merged_count: 1,
        queue_len_after: 0,
        session_id: "s",
        uuid: "u",
      },
      {
        type: "queue_blocked",
        reason: "streaming",
        queue_len: 1,
        session_id: "s",
        uuid: "u",
      },
      {
        type: "queue_cleared",
        reason: "processed",
        cleared_count: 1,
        session_id: "s",
        uuid: "u",
      },
      {
        type: "queue_item_dropped",
        item_id: "i2",
        reason: "buffer_limit",
        queue_len: 0,
        session_id: "s",
        uuid: "u",
      },
    ];

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "queue_item_enqueued",
      "queue_batch_dequeued",
      "queue_blocked",
      "queue_cleared",
      "queue_item_dropped",
    ]);
  });

  test("all events serialize to valid JSON with envelope", () => {
    const event: QueueLifecycleEvent = {
      type: "queue_item_enqueued",
      item_id: "i1",
      client_message_id: "cm-i1",
      source: "task_notification",
      kind: "task_notification",
      queue_len: 2,
      session_id: "listen-abc123",
      uuid: "enqueue-i1",
    };

    const json = JSON.stringify(event);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe("queue_item_enqueued");
    expect(parsed.session_id).toBe("listen-abc123");
    expect(parsed.uuid).toBe("enqueue-i1");
  });

  test("QueueLifecycleEvent is assignable to WireMessage", () => {
    // Compile-time check: if QueueLifecycleEvent is removed from WireMessage,
    // this assignment fails and the test won't compile.
    const event: QueueLifecycleEvent = {
      type: "queue_item_enqueued",
      item_id: "i1",
      client_message_id: "cm-i1",
      source: "user",
      kind: "message",
      queue_len: 1,
      session_id: "s",
      uuid: "u",
    };
    const wire: WireMessage = event;
    expect(wire.type).toBe("queue_item_enqueued");
  });
});
