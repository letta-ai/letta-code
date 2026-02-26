/**
 * Integration tests for PRQ4: TUI QueueRuntime mirror lifecycle events.
 *
 * Drives QueueRuntime directly using the same patterns as the App.tsx dual-path,
 * without requiring React or a TUI instance. Each test mirrors one App.tsx code path.
 *
 * Invariants verified:
 *  - Idle submit: enqueue → consumeItems → onEnqueued + onDequeued, no onBlocked
 *  - Busy submit: enqueue while blocked → onBlocked once; unblock → consumeItems → onDequeued
 *  - Coalesced batch: N enqueues → consumeItems(N) → mergedCount=N
 *  - No double-blocked: tryDequeue same reason N times → onBlocked fires once
 *  - Priority: interrupt_in_progress emitted when streaming also active
 *  - Approval-append (consumeQueuedMessages pattern): consumeItems fires onDequeued, not onCleared
 *  - Queue edit clear (handleEnterQueueEditMode): clear("stale_generation") → onCleared
 *  - Error clear: clear("error") → onCleared
 *  - Divergence: consumeItems(undercount) leaves length mismatch
 *  - Blocked then cleared: both events fire, queue empty
 */

import { describe, expect, test } from "bun:test";
import { getTuiBlockedReason } from "../../cli/helpers/tuiQueueAdapter";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueClearedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { QueueRuntime } from "../../queue/queueRuntime";

// ── Helpers ───────────────────────────────────────────────────────

type Recorded = {
  enqueued: Array<{ item: QueueItem; queueLen: number }>;
  dequeued: DequeuedBatch[];
  blocked: Array<{ reason: QueueBlockedReason; queueLen: number }>;
  cleared: Array<{ reason: QueueClearedReason; count: number }>;
};

function buildRuntime(): { q: QueueRuntime; rec: Recorded } {
  const rec: Recorded = {
    enqueued: [],
    dequeued: [],
    blocked: [],
    cleared: [],
  };
  const q = new QueueRuntime({
    callbacks: {
      onEnqueued: (item, queueLen) => rec.enqueued.push({ item, queueLen }),
      onDequeued: (batch) => rec.dequeued.push(batch),
      onBlocked: (reason, queueLen) => rec.blocked.push({ reason, queueLen }),
      onCleared: (reason, count) => rec.cleared.push({ reason, count }),
    },
  });
  return { q, rec };
}

function enqueueUserMsg(q: QueueRuntime, text = "hello"): void {
  q.enqueue({
    kind: "message",
    source: "user",
    content: text,
  } as Parameters<typeof q.enqueue>[0]);
}

function enqueueTaskNotif(q: QueueRuntime, text = "<notif/>"): void {
  q.enqueue({
    kind: "task_notification",
    source: "task_notification",
    text,
  } as Parameters<typeof q.enqueue>[0]);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("idle submit — single message", () => {
  test("enqueued then consumeItems(1) fires onEnqueued + onDequeued, no blocked", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.blocked).toHaveLength(0);

    q.consumeItems(1);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
    expect(q.length).toBe(0);
  });
});

describe("busy submit — blocked on streaming", () => {
  test("blocked fires on first tryDequeue; consumeItems fires dequeued", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);

    const reason = getTuiBlockedReason({
      streaming: true,
      isExecutingTool: false,
      commandRunning: false,
      pendingApprovalsLen: 0,
      queuedOverlayAction: false,
      anySelectorOpen: false,
      waitingForQueueCancel: false,
      userCancelled: false,
      abortControllerActive: false,
    });
    q.tryDequeue(reason!);
    expect(rec.blocked).toHaveLength(1);
    expect(rec.blocked.at(0)?.reason).toBe("streaming");
    expect(rec.blocked.at(0)?.queueLen).toBe(1);

    // Stream ends: consumeItems fires dequeued
    q.consumeItems(1);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
  });
});

describe("coalesced batch", () => {
  test("two enqueues then consumeItems(2) → mergedCount=2", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q, "first");
    enqueueTaskNotif(q, "<task/>");
    q.consumeItems(2);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.items.at(0)?.kind).toBe("message");
    expect(rec.dequeued.at(0)?.items.at(1)?.kind).toBe("task_notification");
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
  });
});

describe("no double-blocked — QueueRuntime dedup", () => {
  test("tryDequeue same reason 3× → onBlocked fires once", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);
    q.tryDequeue("streaming");
    q.tryDequeue("streaming");
    q.tryDequeue("streaming");
    expect(rec.blocked).toHaveLength(1);
  });

  test("reason change re-fires onBlocked", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);
    q.tryDequeue("streaming");
    q.tryDequeue("pending_approvals"); // reason changed → fires again
    expect(rec.blocked).toHaveLength(2);
    expect(rec.blocked.at(1)?.reason).toBe("pending_approvals");
  });
});

describe("priority: interrupt_in_progress beats streaming", () => {
  test("getTuiBlockedReason returns interrupt_in_progress when streaming also true", () => {
    const reason = getTuiBlockedReason({
      streaming: true,
      isExecutingTool: false,
      commandRunning: false,
      pendingApprovalsLen: 0,
      queuedOverlayAction: false,
      anySelectorOpen: false,
      waitingForQueueCancel: false,
      userCancelled: true, // interrupt_in_progress
      abortControllerActive: false,
    });
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);
    q.tryDequeue(reason!);
    expect(rec.blocked.at(0)?.reason).toBe("interrupt_in_progress");
  });
});

describe("approval-append path (consumeQueuedMessages mirror)", () => {
  test("consumeItems(n) fires onDequeued — items are submitted, not dropped", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q, "queued during approval");
    enqueueTaskNotif(q, "<notif/>");

    // Mirror consumeQueuedMessages: messages.length = 2
    q.consumeItems(2);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.cleared).toHaveLength(0); // NOT a clear
  });
});

describe("queue edit clear (handleEnterQueueEditMode)", () => {
  test("clear('stale_generation') fires onCleared, queue empty", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q, "pending message");
    enqueueUserMsg(q, "another");
    q.clear("stale_generation");
    expect(rec.cleared).toHaveLength(1);
    expect(rec.cleared.at(0)?.reason).toBe("stale_generation");
    expect(rec.cleared.at(0)?.count).toBe(2);
    expect(q.length).toBe(0);
    expect(rec.dequeued).toHaveLength(0); // not a dequeue
  });
});

describe("error clear", () => {
  test("clear('error') fires onCleared with correct count", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q, "pending");
    q.clear("error");
    expect(rec.cleared.at(0)?.reason).toBe("error");
    expect(rec.cleared.at(0)?.count).toBe(1);
    expect(q.length).toBe(0);
  });

  test("clear('error') on empty queue fires with count=0", () => {
    const { q, rec } = buildRuntime();
    q.clear("error");
    expect(rec.cleared.at(0)?.count).toBe(0);
  });
});

describe("divergence scenario — consumeItems undercount", () => {
  test("consumeItems(1) on 2-item queue leaves length=1 (detectable mismatch)", () => {
    const { q } = buildRuntime();
    enqueueUserMsg(q, "first");
    enqueueUserMsg(q, "second");
    q.consumeItems(1); // undercount — simulates drift
    expect(q.length).toBe(1); // mismatch vs expected messageQueue.length=0
  });
});

describe("blocked then cleared", () => {
  test("both onBlocked and onCleared fire; queue ends empty", () => {
    const { q, rec } = buildRuntime();
    enqueueUserMsg(q);
    q.tryDequeue("streaming"); // fires onBlocked
    q.clear("error"); // fires onCleared
    expect(rec.blocked).toHaveLength(1);
    expect(rec.cleared).toHaveLength(1);
    expect(q.length).toBe(0);
  });
});
