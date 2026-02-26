/**
 * Tests for PRQ3: queue lifecycle event emission in headless bidirectional mode.
 *
 * Invariants verified:
 *  - parseUserLine: correctly classifies lines
 *  - blocked events fire directly at arrival time (not via QueueRuntime),
 *    once per turn, on first user/task arrival while turnInProgress
 *  - enqueued + dequeued events fire together at coalescing-loop time
 *    (not at arrival), eliminating orphans from external-tool drop
 *  - external-tool drop scenario: blocked fires at arrival, no enqueued
 *    event for the dropped item
 *  - exit paths emit queue_cleared
 *  - control lines produce no events
 */

import { describe, expect, test } from "bun:test";
import type { BidirectionalQueuedInput } from "../../headless";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueClearedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { QueueRuntime } from "../../queue/queueRuntime";

// ── Helpers mirroring production logic ───────────────────────────

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

/** Mirrors enqueueForTracking() from headless. */
function enqueueForTracking(
  q: QueueRuntime,
  input: BidirectionalQueuedInput,
): void {
  if (input.kind === "task_notification") {
    q.enqueue({
      kind: "task_notification",
      source: "task_notification",
      text: input.text,
    } as Parameters<typeof q.enqueue>[0]);
  } else {
    q.enqueue({
      kind: "message",
      source: "user",
      content: input.content,
    } as Parameters<typeof q.enqueue>[0]);
  }
}

/** Mirrors maybeNotifyBlocked(): emits queue_blocked directly on first busy arrival. */
type BlockedState = { emitted: boolean };

function maybeNotifyBlocked(
  raw: string,
  turnInProgress: boolean,
  state: BlockedState,
  blocked: Array<{ reason: string; queueLen: number }>,
  lineQueue: string[],
): void {
  if (!turnInProgress || state.emitted) return;
  if (!parseUserLine(raw)) return;
  state.emitted = true;
  const queueLen = Math.max(
    1,
    lineQueue.filter((l) => parseUserLine(l) !== null).length,
  );
  blocked.push({ reason: "runtime_busy", queueLen });
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
    const r = parseUserLine(makeUserLine("hello"));
    expect(r?.kind).toBe("message");
    expect(r?.content).toBe("hello");
  });
  test("returns task_notification for task line", () => {
    const r = parseUserLine(makeTaskLine("<notif/>"));
    expect(r?.kind).toBe("task_notification");
    expect(r?.content).toBe("<notif/>");
  });
});

describe("idle path — enqueued + dequeued fire together at coalescing time", () => {
  test("no enqueued at arrival, enqueued+dequeued together in coalescing loop", () => {
    const { q, rec } = buildRuntime();
    // Simulate: line arrives while idle → no enqueue at arrival
    const lineQueue: string[] = [];
    const blocked: Array<{ reason: string; queueLen: number }> = [];
    const bstate: BlockedState = { emitted: false };
    const raw = makeUserLine("hello");
    lineQueue.push(raw);
    maybeNotifyBlocked(raw, false /* idle */, bstate, blocked, lineQueue);
    expect(rec.enqueued).toHaveLength(0); // not yet
    expect(blocked).toHaveLength(0); // idle: no blocked

    // Coalescing loop consumes the item
    const input: BidirectionalQueuedInput = { kind: "user", content: "hello" };
    enqueueForTracking(q, input);
    q.consumeItems(1);

    expect(rec.enqueued).toHaveLength(1);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
  });
});

describe("busy path — blocked fires at arrival, enqueued+dequeued at next turn", () => {
  test("blocked fires on first user arrival during turn; enqueued fires at coalescing", () => {
    const { q, rec } = buildRuntime();
    const lineQueue: string[] = [];
    const blocked: Array<{ reason: string; queueLen: number }> = [];
    const bstate: BlockedState = { emitted: false };

    // Turn 1 in progress
    const raw = makeUserLine("msg-during-turn");
    lineQueue.push(raw);
    maybeNotifyBlocked(raw, true /* busy */, bstate, blocked, lineQueue);
    expect(blocked).toHaveLength(1);
    expect(blocked.at(0)?.reason).toBe("runtime_busy");
    expect(rec.enqueued).toHaveLength(0); // NOT enqueued yet at arrival

    // Second arrival — no new blocked (dedup)
    const raw2 = makeUserLine("msg2");
    lineQueue.push(raw2);
    maybeNotifyBlocked(raw2, true, bstate, blocked, lineQueue);
    expect(blocked).toHaveLength(1); // still 1

    // Turn ends, bstate resets
    bstate.emitted = false;

    // Turn 2 coalescing loop consumes both
    for (const input of [
      { kind: "user" as const, content: "msg-during-turn" },
      { kind: "user" as const, content: "msg2" },
    ]) {
      enqueueForTracking(q, input);
    }
    q.consumeItems(2);

    expect(rec.enqueued).toHaveLength(2);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
  });
});

describe("external-tool drop scenario — no orphaned items", () => {
  test("blocked fires at arrival, dropped line never enters QueueRuntime", () => {
    const { q, rec } = buildRuntime();
    const lineQueue: string[] = [];
    const blocked: Array<{ reason: string; queueLen: number }> = [];
    const bstate: BlockedState = { emitted: false };

    // User line arrives during turn (external-tool wait in progress)
    const raw = makeUserLine("user-msg-during-ext-tool");
    lineQueue.push(raw);
    maybeNotifyBlocked(raw, true, bstate, blocked, lineQueue);
    expect(blocked).toHaveLength(1); // blocked fires on arrival

    // External-tool wait loop DROPS the line (not deferred back, just consumed)
    lineQueue.shift(); // simulates getNextLine() consuming without deferring

    // QueueRuntime should have NO items (arrival never enqueued)
    expect(q.length).toBe(0);
    expect(rec.enqueued).toHaveLength(0);

    // consumeItems(0) — nothing was in the coalescing loop (no user items)
    const result = q.consumeItems(0);
    expect(result).toBeNull();
    expect(rec.dequeued).toHaveLength(0); // no dequeue event
  });
});

describe("control line barrier", () => {
  test("control line produces no events", () => {
    const { q, rec } = buildRuntime();
    const lineQueue: string[] = [];
    const blocked: Array<{ reason: string; queueLen: number }> = [];
    const bstate: BlockedState = { emitted: false };

    maybeNotifyBlocked(makeControlLine(), true, bstate, blocked, lineQueue);
    expect(blocked).toHaveLength(0);
    expect(rec.enqueued).toHaveLength(0);
    expect(q.length).toBe(0);
  });
});

describe("coalesced batch — task + user", () => {
  test("enqueueForTracking + consumeItems(2) fires correct batch", () => {
    const { q, rec } = buildRuntime();
    const inputs: BidirectionalQueuedInput[] = [
      { kind: "task_notification", text: "<notif/>" },
      { kind: "user", content: "follow-up" },
    ];
    for (const input of inputs) enqueueForTracking(q, input);
    q.consumeItems(2);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.items.at(0)?.kind).toBe("task_notification");
    expect(rec.dequeued.at(0)?.items.at(1)?.kind).toBe("message");
  });
});

describe("exit paths", () => {
  test("clear(shutdown) emits queue_cleared and drains", () => {
    const { q, rec } = buildRuntime();
    enqueueForTracking(q, { kind: "user", content: "pending" });
    q.clear("shutdown");
    expect(rec.cleared.at(0)?.reason).toBe("shutdown");
    expect(rec.cleared.at(0)?.count).toBe(1);
    expect(q.length).toBe(0);
  });
  test("clear(error) emits queue_cleared", () => {
    const { q, rec } = buildRuntime();
    enqueueForTracking(q, { kind: "user", content: "pending" });
    q.clear("error");
    expect(rec.cleared.at(0)?.reason).toBe("error");
  });
  test("clear on empty queue fires with count=0", () => {
    const { q, rec } = buildRuntime();
    q.clear("shutdown");
    expect(rec.cleared.at(0)?.count).toBe(0);
  });
});
