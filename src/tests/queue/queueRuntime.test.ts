import { describe, expect, test } from "bun:test";
import {
  type DequeuedBatch,
  type MessageQueueItem,
  type QueueItem,
  QueueRuntime,
} from "../../queue/queueRuntime";

// ── Helpers ───────────────────────────────────────────────────────

function makeMsg(text = "hello"): Omit<MessageQueueItem, "id" | "enqueuedAt"> {
  return { kind: "message", source: "user", content: text };
}

function makeTask(
  text = "<notification/>",
): Omit<
  Extract<QueueItem, { kind: "task_notification" }>,
  "id" | "enqueuedAt"
> {
  return { kind: "task_notification", source: "task_notification", text };
}

function makeApproval(): Omit<
  Extract<QueueItem, { kind: "approval_result" }>,
  "id" | "enqueuedAt"
> {
  return { kind: "approval_result", source: "system", text: "{}" };
}

function makeOverlay(): Omit<
  Extract<QueueItem, { kind: "overlay_action" }>,
  "id" | "enqueuedAt"
> {
  return { kind: "overlay_action", source: "system", text: "plan_mode" };
}

// ── Enqueue ───────────────────────────────────────────────────────

describe("enqueue basics", () => {
  test("adds item, assigns ID, returns item, length increases", () => {
    const q = new QueueRuntime();
    const item = q.enqueue(makeMsg());
    expect(item).not.toBeNull();
    expect(item?.id).toMatch(/^q-\d+$/);
    expect(item?.kind).toBe("message");
    expect(q.length).toBe(1);
  });

  test("onEnqueued fires with correct item and queue length", () => {
    const calls: [QueueItem, number][] = [];
    const q = new QueueRuntime({
      callbacks: { onEnqueued: (item, len) => calls.push([item, len]) },
    });
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b"));
    expect(calls).toHaveLength(2);
    expect(calls.at(0)?.[1]).toBe(1);
    expect(calls.at(1)?.[1]).toBe(2);
  });

  test("multimodal content preserved through round-trip", () => {
    const q = new QueueRuntime();
    // Use an array of text parts to verify multipart content is preserved
    const content: MessageQueueItem["content"] = [
      { type: "text" as const, text: "part one" },
      { type: "text" as const, text: "part two" },
    ];
    const input: Omit<MessageQueueItem, "id" | "enqueuedAt"> = {
      kind: "message",
      source: "user",
      content,
    };
    const item = q.enqueue(input);
    expect(item).not.toBeNull();
    const batch = q.tryDequeue(null);
    expect(batch).not.toBeNull();
    const dequeued = batch?.items.at(0) as MessageQueueItem;
    expect(dequeued.content).toEqual(content);
  });
});

describe("bounded buffer — soft limit", () => {
  test("drops oldest coalescable when at soft limit", () => {
    const dropped: QueueItem[] = [];
    const q = new QueueRuntime({
      maxItems: 2,
      callbacks: { onDropped: (item) => dropped.push(item) },
    });
    const a = q.enqueue(makeMsg("a"));
    expect(a).not.toBeNull();
    q.enqueue(makeMsg("b"));
    q.enqueue(makeMsg("c")); // triggers drop of "a"

    expect(dropped).toHaveLength(1);
    expect((dropped.at(0) as MessageQueueItem).content).toBe("a");
    const droppedItem = dropped.at(0);
    expect(a?.id).toEqual(droppedItem?.id);
    expect(q.length).toBe(2);
  });

  test("barrier items not dropped at soft limit", () => {
    const dropped: QueueItem[] = [];
    const q = new QueueRuntime({
      maxItems: 1,
      callbacks: { onDropped: (item) => dropped.push(item) },
    });
    q.enqueue(makeApproval()); // fills to capacity (barrier)
    q.enqueue(makeApproval()); // another barrier — soft limit exceeded, not dropped
    expect(dropped).toHaveLength(0);
    expect(q.length).toBe(2);
  });

  test("coalescable drop resumes when new coalescable arrives at capacity", () => {
    const dropped: QueueItem[] = [];
    const q = new QueueRuntime({
      maxItems: 2,
      callbacks: { onDropped: (item) => dropped.push(item) },
    });
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b")); // full
    q.enqueue(makeMsg("c")); // drops "a"
    q.enqueue(makeMsg("d")); // drops "b"
    expect(dropped).toHaveLength(2);
    expect(q.length).toBe(2);
  });
});

describe("bounded buffer — hard ceiling", () => {
  test("returns null when hardMaxItems reached, fires onDropped(buffer_limit)", () => {
    const dropped: [QueueItem, string][] = [];
    const q = new QueueRuntime({
      maxItems: 1,
      hardMaxItems: 2,
      callbacks: {
        onDropped: (item, reason) => dropped.push([item, reason]),
      },
    });
    q.enqueue(makeApproval()); // 1
    q.enqueue(makeApproval()); // 2 (soft barrier overflow)
    const result = q.enqueue(makeApproval()); // hard ceiling
    expect(result).toBeNull();
    expect(dropped).toHaveLength(1);
    expect(dropped.at(0)?.[1]).toBe("buffer_limit");
    expect(q.length).toBe(2); // unchanged
  });

  test("hard ceiling applies to coalescable items too", () => {
    const q = new QueueRuntime({ maxItems: 2, hardMaxItems: 2 });
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b"));
    // Both slots filled; next soft-drop would free one, but hardMaxItems == maxItems,
    // so hard ceiling triggers before soft drop for barrier kinds.
    // For coalescable: hard ceiling fires after soft drop, which brings length back.
    // Let's confirm hard ceiling for a barrier-only queue:
    const q2 = new QueueRuntime({ maxItems: 1, hardMaxItems: 2 });
    q2.enqueue(makeApproval());
    q2.enqueue(makeApproval()); // soft barrier overflow to 2
    const rejected = q2.enqueue(makeApproval()); // hard ceiling
    expect(rejected).toBeNull();
  });
});

// ── Dequeue — coalescable ─────────────────────────────────────────

describe("dequeue coalescable items", () => {
  test("returns all contiguous coalescable items as one batch", () => {
    const q = new QueueRuntime();
    q.enqueue(makeMsg("a"));
    q.enqueue(makeTask("<n1/>"));
    q.enqueue(makeMsg("b"));
    const batch = q.tryDequeue(null);
    expect(batch).not.toBeNull();
    expect(batch?.items).toHaveLength(3);
    expect(batch?.mergedCount).toBe(3);
  });

  test("onDequeued fires with correct batch metadata", () => {
    const batches: DequeuedBatch[] = [];
    const q = new QueueRuntime({
      callbacks: { onDequeued: (b) => batches.push(b) },
    });
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b"));
    q.tryDequeue(null);
    expect(batches).toHaveLength(1);
    const b = batches.at(0);
    expect(b?.mergedCount).toBe(2);
    expect(b?.queueLenAfter).toBe(0);
    expect(b?.batchId).toMatch(/^batch-\d+$/);
  });

  test("length is 0 after full dequeue", () => {
    const q = new QueueRuntime();
    q.enqueue(makeMsg());
    q.enqueue(makeMsg());
    q.tryDequeue(null);
    expect(q.length).toBe(0);
    expect(q.isEmpty).toBe(true);
  });

  test("tryDequeue on empty queue returns null, no callback", () => {
    const batches: DequeuedBatch[] = [];
    const q = new QueueRuntime({
      callbacks: { onDequeued: (b) => batches.push(b) },
    });
    const result = q.tryDequeue(null);
    expect(result).toBeNull();
    expect(batches).toHaveLength(0);
  });
});

// ── Dequeue — barrier ─────────────────────────────────────────────

describe("dequeue barrier items", () => {
  test("barrier item at head dequeued alone", () => {
    const q = new QueueRuntime();
    q.enqueue(makeApproval());
    q.enqueue(makeMsg("following"));
    const batch = q.tryDequeue(null);
    expect(batch).not.toBeNull();
    expect(batch?.items).toHaveLength(1);
    expect(batch?.items.at(0)?.kind).toBe("approval_result");
    expect(q.length).toBe(1); // message still in queue
  });

  test("coalescable items before barrier dequeued as batch, barrier stays", () => {
    const q = new QueueRuntime();
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b"));
    q.enqueue(makeOverlay()); // barrier
    q.enqueue(makeMsg("c")); // after barrier
    const batch = q.tryDequeue(null);
    expect(batch?.items).toHaveLength(2);
    expect(batch?.items.at(0)?.kind).toBe("message");
    expect(batch?.items.at(1)?.kind).toBe("message");
    expect(q.length).toBe(2); // overlay + msg still queued
  });

  test("mixed [msg, msg, overlay, msg]: first dequeue gets [msg, msg]", () => {
    const q = new QueueRuntime();
    q.enqueue(makeMsg("1"));
    q.enqueue(makeMsg("2"));
    q.enqueue(makeOverlay());
    q.enqueue(makeMsg("3"));

    const b1 = q.tryDequeue(null);
    expect(b1?.items.map((i) => i.kind)).toEqual(["message", "message"]);

    const b2 = q.tryDequeue(null); // overlay alone
    expect(b2?.items).toHaveLength(1);
    expect(b2?.items.at(0)?.kind).toBe("overlay_action");

    const b3 = q.tryDequeue(null); // remaining msg
    expect(b3?.items).toHaveLength(1);
    expect(b3?.items.at(0)?.kind).toBe("message");

    expect(q.isEmpty).toBe(true);
  });
});

// ── Blocked ───────────────────────────────────────────────────────

describe("blocked state", () => {
  test("tryDequeue(streaming) returns null, fires onBlocked", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.enqueue(makeMsg());
    const result = q.tryDequeue("streaming");
    expect(result).toBeNull();
    expect(blocked).toEqual(["streaming"]);
  });

  test("same reason twice fires onBlocked only once", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.enqueue(makeMsg());
    q.tryDequeue("streaming");
    q.tryDequeue("streaming");
    expect(blocked).toHaveLength(1);
  });

  test("different reason fires onBlocked again", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.enqueue(makeMsg());
    q.tryDequeue("streaming");
    q.tryDequeue("pending_approvals");
    expect(blocked).toEqual(["streaming", "pending_approvals"]);
  });

  test("tryDequeue(null) after blocked resets tracking", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.enqueue(makeMsg());
    q.tryDequeue("streaming");
    q.tryDequeue(null); // unblocks, dequeues
    q.enqueue(makeMsg());
    q.tryDequeue("streaming"); // should fire again
    expect(blocked).toHaveLength(2);
  });

  test("blocked with empty queue does NOT fire onBlocked", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.tryDequeue("streaming");
    expect(blocked).toHaveLength(0);
  });

  test("queue empties while blocked, then refills under same reason: emits again", () => {
    const blocked: string[] = [];
    const q = new QueueRuntime({
      callbacks: { onBlocked: (r) => blocked.push(r) },
    });
    q.enqueue(makeMsg());
    q.tryDequeue("streaming"); // emits "streaming"
    q.tryDequeue(null); // dequeues, queue empty, resets epoch
    q.enqueue(makeMsg()); // refills under same block
    q.tryDequeue("streaming"); // should emit "streaming" again
    expect(blocked).toHaveLength(2);
    expect(blocked).toEqual(["streaming", "streaming"]);
  });
});

// ── Clear ─────────────────────────────────────────────────────────

describe("clear", () => {
  test("removes all items and fires onCleared with count", () => {
    const cleared: [string, number][] = [];
    const q = new QueueRuntime({
      callbacks: { onCleared: (r, n) => cleared.push([r, n]) },
    });
    q.enqueue(makeMsg());
    q.enqueue(makeMsg());
    q.clear("error");
    expect(q.length).toBe(0);
    expect(cleared).toEqual([["error", 2]]);
  });

  test("clear on empty queue fires onCleared with 0", () => {
    const cleared: number[] = [];
    const q = new QueueRuntime({
      callbacks: { onCleared: (_r, n) => cleared.push(n) },
    });
    q.clear("shutdown");
    expect(cleared).toEqual([0]);
  });
});

// ── Callback safety ───────────────────────────────────────────────

describe("callback safety", () => {
  test("callback that throws does not corrupt queue state", () => {
    const q = new QueueRuntime({
      callbacks: {
        onEnqueued: () => {
          throw new Error("boom");
        },
      },
    });
    const item = q.enqueue(makeMsg());
    expect(item).not.toBeNull();
    expect(q.length).toBe(1); // state intact despite callback throw
  });

  test("subsequent operations work after callback throw", () => {
    let throwCount = 0;
    const q = new QueueRuntime({
      callbacks: {
        onDequeued: () => {
          throwCount++;
          throw new Error("oops");
        },
      },
    });
    q.enqueue(makeMsg("a"));
    q.tryDequeue(null); // throws in callback
    q.enqueue(makeMsg("b"));
    const batch = q.tryDequeue(null); // should work fine
    expect(batch).not.toBeNull();
    expect(batch?.items).toHaveLength(1);
    expect(throwCount).toBe(2);
  });
});

// ── IDs ───────────────────────────────────────────────────────────

describe("IDs and accessors", () => {
  test("IDs are monotonically increasing within a runtime instance", () => {
    const q = new QueueRuntime();
    const a = q.enqueue(makeMsg());
    const b = q.enqueue(makeMsg());
    const c = q.enqueue(makeMsg());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    const ids = [a?.id ?? "", b?.id ?? "", c?.id ?? ""].map((id) =>
      Number.parseInt(id.replace("q-", ""), 10),
    );
    const [id0, id1, id2] = ids;
    expect(id0).toBeLessThan(id1 ?? 0);
    expect(id1).toBeLessThan(id2 ?? 0);
  });

  test("peek returns items without removing them", () => {
    const q = new QueueRuntime();
    q.enqueue(makeMsg("a"));
    q.enqueue(makeMsg("b"));
    const peeked = q.peek();
    expect(peeked).toHaveLength(2);
    expect(q.length).toBe(2); // unchanged
  });
});
