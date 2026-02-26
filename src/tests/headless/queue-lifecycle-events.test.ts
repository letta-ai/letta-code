/**
 * Integration-level tests for PRQ3: queue lifecycle event emission in
 * headless bidirectional mode.
 *
 * These tests drive the internal helpers (parseUserLine, maybeEnqueueLine,
 * QueueRuntime wiring) directly rather than spawning a full headless process,
 * since the production code path is inside runBidirectionalMode which requires
 * a live agent/server connection.
 *
 * The key invariants verified:
 *  - Only user/task lines produce queue events (not control lines)
 *  - Idle path: enqueued → dequeued, no blocked
 *  - Busy path: enqueued → blocked(runtime_busy) → dequeued next turn
 *  - consumeItems(n) fires onDequeued with exact coalesced count
 *  - Error/shutdown exit paths emit queue_cleared
 *  - resetBlockedState re-enables blocked emission after turn completes
 */

import { describe, expect, test } from "bun:test";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueClearedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { QueueRuntime } from "../../queue/queueRuntime";

// ── Helpers mirroring headless parseUserLine logic ────────────────

type ParsedLine =
  | { kind: "message"; content: string }
  | { kind: "task_notification"; content: string }
  | null;

function parseUserLine(raw: string): ParsedLine {
  if (!raw.trim()) return null;
  try {
    const parsed: {
      type?: string;
      message?: { content?: string };
      _queuedKind?: string;
    } = JSON.parse(raw);
    if (parsed.type !== "user" || parsed.message?.content === undefined)
      return null;
    const kind =
      parsed._queuedKind === "task_notification"
        ? "task_notification"
        : "message";
    return { kind, content: parsed.message.content };
  } catch {
    return null;
  }
}

function makeUserLine(content: string): string {
  return JSON.stringify({ type: "user", message: { content } });
}

function makeTaskLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { content: text },
    _queuedKind: "task_notification",
  });
}

function makeControlLine(requestId = "req-1"): string {
  return JSON.stringify({
    type: "control_response",
    response: { subtype: "decision", request_id: requestId, decision: "allow" },
  });
}

// ── Shared queue builder ──────────────────────────────────────────

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

function enqueueLine(q: QueueRuntime, raw: string, busy: boolean): void {
  const parsed = parseUserLine(raw);
  if (!parsed) return;
  if (parsed.kind === "task_notification") {
    q.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: parsed.content,
    } as Parameters<typeof q.enqueue>[0]);
  } else {
    q.enqueue({
      kind: "message",
      source: "user",
      content: parsed.content,
    } as Parameters<typeof q.enqueue>[0]);
  }
  if (busy) q.tryDequeue("runtime_busy");
}

// ── Tests ─────────────────────────────────────────────────────────

describe("parseUserLine", () => {
  test("returns null for control_response", () => {
    expect(parseUserLine(makeControlLine())).toBeNull();
  });

  test("returns null for empty/whitespace", () => {
    expect(parseUserLine("")).toBeNull();
    expect(parseUserLine("   ")).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseUserLine("{not json")).toBeNull();
  });

  test("returns message for user line", () => {
    const result = parseUserLine(makeUserLine("hello"));
    expect(result?.kind).toBe("message");
    expect(result?.content).toBe("hello");
  });

  test("returns task_notification for task line", () => {
    const result = parseUserLine(makeTaskLine("<notif/>"));
    expect(result?.kind).toBe("task_notification");
    expect(result?.content).toBe("<notif/>");
  });
});

describe("idle path — single message", () => {
  test("enqueued fires, then consumeItems(1) fires dequeued, no blocked", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("hello"), false); // agent idle
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.blocked).toHaveLength(0);

    q.consumeItems(1); // coalescing loop consumed 1 item
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
    expect(q.length).toBe(0);
  });
});

describe("busy path — message during turn", () => {
  test("enqueued + blocked(runtime_busy) when agent is processing", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("msg1"), false); // first: idle
    q.consumeItems(1); // turn 1 dequeued

    enqueueLine(q, makeUserLine("msg2"), true); // second: busy
    expect(rec.enqueued).toHaveLength(2);
    expect(rec.blocked).toHaveLength(1);
    expect(rec.blocked.at(0)?.reason).toBe("runtime_busy");
    expect(rec.blocked.at(0)?.queueLen).toBe(1);

    // Turn 2 starts: consumeItems(1) fires dequeued
    q.consumeItems(1);
    expect(rec.dequeued).toHaveLength(2);
    expect(rec.dequeued.at(1)?.mergedCount).toBe(1);
    expect(rec.dequeued.at(1)?.queueLenAfter).toBe(0);
  });

  test("blocked fires only once for same reason until resetBlockedState", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("a"), true);
    enqueueLine(q, makeUserLine("b"), true); // same reason — no second blocked
    expect(rec.blocked).toHaveLength(1);

    q.resetBlockedState();
    enqueueLine(q, makeUserLine("c"), true); // after reset — fires again
    expect(rec.blocked).toHaveLength(2);
  });
});

describe("coalescing — task + user in same turn", () => {
  test("consumeItems(2) emits dequeued with mergedCount=2", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeTaskLine("<notif/>"), false);
    enqueueLine(q, makeUserLine("follow-up"), false);
    // coalescing loop consumed both
    q.consumeItems(2);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.items.at(0)?.kind).toBe("task_notification");
    expect(rec.dequeued.at(0)?.items.at(1)?.kind).toBe("message");
  });
});

describe("control line barrier", () => {
  test("control line produces no queue event", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeControlLine(), false);
    expect(rec.enqueued).toHaveLength(0);
    expect(rec.blocked).toHaveLength(0);
    expect(q.length).toBe(0);
  });

  test("user line after control line still enqueues (next turn pass)", () => {
    const { q, rec } = buildRuntime();
    // lineQueue: [control_response, user_msg]
    // coalescing loop stops at control_response, so only user_msg is from next pass
    enqueueLine(q, makeControlLine(), false); // not enqueued
    enqueueLine(q, makeUserLine("after-control"), false); // enqueued
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.enqueued.at(0)?.item.kind).toBe("message");

    // When this turn processes just the user_msg, consumeItems(1)
    q.consumeItems(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
  });
});

describe("resetBlockedState after turn", () => {
  test("resets after turn so next arrival correctly emits blocked", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("a"), true); // blocked
    q.consumeItems(1);
    q.resetBlockedState(); // turn finished

    enqueueLine(q, makeUserLine("b"), true); // should emit blocked again
    expect(rec.blocked).toHaveLength(2);
  });
});

describe("exit paths", () => {
  test("clear(shutdown) emits queue_cleared and drains", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("pending"), false);
    q.clear("shutdown");
    expect(rec.cleared).toHaveLength(1);
    expect(rec.cleared.at(0)?.reason).toBe("shutdown");
    expect(rec.cleared.at(0)?.count).toBe(1);
    expect(q.length).toBe(0);
  });

  test("clear(error) emits queue_cleared", () => {
    const { q, rec } = buildRuntime();
    enqueueLine(q, makeUserLine("pending"), false);
    q.clear("error");
    expect(rec.cleared.at(0)?.reason).toBe("error");
  });

  test("clear on empty queue fires with count=0", () => {
    const { q, rec } = buildRuntime();
    q.clear("shutdown");
    expect(rec.cleared.at(0)?.count).toBe(0);
  });
});
