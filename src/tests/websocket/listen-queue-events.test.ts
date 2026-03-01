/**
 * Integration-level tests for PRQ5: queue lifecycle event emission in
 * listen-client.ts.
 *
 * These tests drive QueueRuntime directly, mirroring the wiring pattern in
 * listen-client to verify:
 *  - Single message: enqueued → dequeued, no blocked, real queue_len
 *  - Two rapid synchronous arrivals: second gets blocked(runtime_busy)
 *    because pendingTurns is incremented before the .then() chain
 *  - Connection close: queue_cleared("shutdown") emitted once
 *  - Per-turn error: no queue_cleared — queue continues for remaining turns
 *  - ApprovalCreate payloads (no `content` field) are not enqueued
 *  - QueueLifecycleEvent is assignable to WsProtocolEvent (type-level)
 */

import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueClearedReason,
  QueueItem,
} from "../../queue/queueRuntime";
import { QueueRuntime } from "../../queue/queueRuntime";
import type { QueueLifecycleEvent } from "../../types/protocol";
import type { WsProtocolEvent } from "../../websocket/listen-client";

// ── Type-level assertion: QueueLifecycleEvent ⊆ WsProtocolEvent ──
// Imports the real WsProtocolEvent from listen-client. If QueueLifecycleEvent
// is ever removed from that union, this assertion fails at compile time.
type _AssertAssignable = QueueLifecycleEvent extends WsProtocolEvent
  ? true
  : never;
const _typeCheck: _AssertAssignable = true;
void _typeCheck; // suppress unused warning

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

/** Mirrors listen-client message arrival logic for a MessageCreate payload. */
function simulateMessageArrival(
  q: QueueRuntime,
  pendingTurnsRef: { value: number },
  payload: MessageCreate | ApprovalCreate,
): { isUserMessage: boolean; queueItemId?: string } {
  const isUserMessage = "content" in payload;
  let queueItemId: string | undefined;
  if (isUserMessage) {
    const enqueued = q.enqueue({
      kind: "message",
      source: "user",
      content: (payload as MessageCreate).content,
    } as Parameters<typeof q.enqueue>[0]);
    queueItemId = enqueued?.id;
    if (pendingTurnsRef.value > 0) {
      q.tryDequeue("runtime_busy");
    }
  }
  pendingTurnsRef.value++; // synchronous before .then()
  return { isUserMessage, queueItemId };
}

/** Mirrors the start of the .then() chain callback. */
function simulateTurnStart(
  q: QueueRuntime,
  _pendingTurnsRef: { value: number },
  arrival: { isUserMessage: boolean; queueItemId?: string },
  skipIds: Set<string>,
): void {
  if (!arrival.isUserMessage || !arrival.queueItemId) {
    return;
  }

  if (skipIds.has(arrival.queueItemId)) {
    skipIds.delete(arrival.queueItemId);
    return;
  }

  const batch = q.tryDequeue(null);
  if (!batch) {
    return;
  }
  for (const item of batch.items) {
    if (item.id !== arrival.queueItemId) {
      skipIds.add(item.id);
    }
  }
}

/** Mirrors the finally block. */
function simulateTurnEnd(
  q: QueueRuntime,
  pendingTurnsRef: { value: number },
): void {
  pendingTurnsRef.value--;
  if (pendingTurnsRef.value === 0) q.resetBlockedState();
}

function makeMessageCreate(text = "hello"): MessageCreate {
  return { role: "user", content: text } as unknown as MessageCreate;
}

function makeApprovalCreate(): ApprovalCreate {
  // ApprovalCreate does NOT have a `content` field — used for legacy approval path
  return { type: "approval", approvals: [] } as unknown as ApprovalCreate;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("single message — idle path", () => {
  test("enqueued → dequeued, no blocked, real queue_len values", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const firstArrival = simulateMessageArrival(q, turns, makeMessageCreate());
    expect(rec.enqueued).toHaveLength(1);
    expect(rec.enqueued.at(0)?.queueLen).toBe(1);
    expect(rec.blocked).toHaveLength(0);

    simulateTurnStart(q, turns, firstArrival, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(1);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);

    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
    expect(q.length).toBe(0);
  });
});

describe("two rapid messages — busy path", () => {
  test("second arrival gets blocked(runtime_busy) due to sync pendingTurns", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    // First message arrives
    const arrival1 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("first"),
    );
    expect(turns.value).toBe(1); // synchronously incremented
    expect(rec.blocked).toHaveLength(0); // was 0 at arrival

    // Second message arrives BEFORE first turn's .then() runs
    const arrival2 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("second"),
    );
    expect(turns.value).toBe(2);
    expect(rec.blocked).toHaveLength(1);
    expect(rec.blocked.at(0)?.reason).toBe("runtime_busy");
    expect(rec.blocked.at(0)?.queueLen).toBe(2); // both enqueued

    // First turn runs
    simulateTurnStart(q, turns, arrival1, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(1); // second still pending

    // Second callback no-ops (item already consumed in coalesced batch).
    simulateTurnStart(q, turns, arrival2, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
  });

  test("blocked fires only once for same reason; resets when fully drained", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const arrivalA = simulateMessageArrival(q, turns, makeMessageCreate("a"));
    const arrivalB = simulateMessageArrival(q, turns, makeMessageCreate("b")); // blocked
    const arrivalC = simulateMessageArrival(q, turns, makeMessageCreate("c")); // same reason — no extra blocked
    expect(rec.blocked).toHaveLength(1);

    // Drain all three
    const queuedArrivals = [arrivalA, arrivalB, arrivalC];
    for (let i = 0; i < 3; i++) {
      const queuedArrival = queuedArrivals[i];
      if (!queuedArrival) {
        continue;
      }
      simulateTurnStart(q, turns, queuedArrival, skipIds);
      simulateTurnEnd(q, turns);
    }
    expect(turns.value).toBe(0);

    // New arrival after full drain — should be idle (no blocked)
    simulateMessageArrival(q, turns, makeMessageCreate("d"));
    expect(rec.blocked).toHaveLength(1); // still just the original one
  });
});

describe("pendingTurns safety — always decremented", () => {
  test("pendingTurns decrements even when simulateTurnStart would throw", () => {
    // Mirrors the production fix: onStatusChange("receiving") moved inside try
    // so the finally always fires. Here we verify that the turn-end path
    // (finally equivalent) always restores pendingTurns to 0.
    const { q } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const arrival = simulateMessageArrival(q, turns, makeMessageCreate("msg"));
    expect(turns.value).toBe(1);

    // Simulate: consumeItems fires, then an error before handleIncomingMessage
    simulateTurnStart(q, turns, arrival, skipIds);
    // finally fires (error path)
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0); // not leaked
    expect(q.length).toBe(0);
  });
});

describe("ApprovalCreate payloads", () => {
  test("ApprovalCreate is not enqueued (no content field)", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const arrival = simulateMessageArrival(q, turns, makeApprovalCreate());
    expect(arrival.isUserMessage).toBe(false);
    expect(rec.enqueued).toHaveLength(0);
    expect(turns.value).toBe(1); // pendingTurns still increments

    // No consumeItems called in .then()
    simulateTurnStart(q, turns, arrival, skipIds);
    expect(rec.dequeued).toHaveLength(0);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
  });
});

describe("connection close", () => {
  test("clear(shutdown) emits queue_cleared exactly once for intentional close", () => {
    const { q, rec } = buildRuntime();
    q.clear("shutdown");
    expect(rec.cleared).toHaveLength(1);
    expect(rec.cleared.at(0)?.reason).toBe("shutdown");
    expect(rec.cleared.at(0)?.count).toBe(0);
  });

  test("clear(shutdown) emits with correct count when items are pending", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    simulateMessageArrival(q, turns, makeMessageCreate("pending"));
    q.clear("shutdown"); // connection closed before turn ran
    expect(rec.cleared.at(0)?.count).toBe(1);
    expect(q.length).toBe(0);
  });
});

describe("per-turn error — no queue_cleared", () => {
  test("turn error only decrements pendingTurns; remaining turns still dequeue", () => {
    const { q, rec } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const arrival1 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("first"),
    );
    const arrival2 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("second"),
    );

    // First turn: simulate error — finally still runs
    simulateTurnStart(q, turns, arrival1, skipIds);
    simulateTurnEnd(q, turns); // error path still hits finally
    expect(rec.cleared).toHaveLength(0); // no queue_cleared

    // Second callback no-ops; first turn already consumed coalesced batch.
    simulateTurnStart(q, turns, arrival2, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
    expect(rec.cleared).toHaveLength(0); // still no queue_cleared
  });
});
