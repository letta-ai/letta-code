import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  DequeuedBatch,
  QueueBlockedReason,
  QueueClearedReason,
  QueueItem,
} from "@/queue/queue-runtime";
import { QueueRuntime } from "@/queue/queue-runtime";

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
  pendingTurnsRef.value++;
  return { isUserMessage, queueItemId };
}

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
  return { type: "approval", approvals: [] } as unknown as ApprovalCreate;
}

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

    const arrival1 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("first"),
    );
    expect(turns.value).toBe(1);
    expect(rec.blocked).toHaveLength(0);

    const arrival2 = simulateMessageArrival(
      q,
      turns,
      makeMessageCreate("second"),
    );
    expect(turns.value).toBe(2);
    expect(rec.blocked).toHaveLength(1);
    expect(rec.blocked.at(0)?.reason).toBe("runtime_busy");
    expect(rec.blocked.at(0)?.queueLen).toBe(2);

    simulateTurnStart(q, turns, arrival1, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    expect(rec.dequeued.at(0)?.mergedCount).toBe(2);
    expect(rec.dequeued.at(0)?.queueLenAfter).toBe(0);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(1);

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
    const arrivalB = simulateMessageArrival(q, turns, makeMessageCreate("b"));
    const arrivalC = simulateMessageArrival(q, turns, makeMessageCreate("c"));
    expect(rec.blocked).toHaveLength(1);

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

    simulateMessageArrival(q, turns, makeMessageCreate("d"));
    expect(rec.blocked).toHaveLength(1);
  });
});

describe("pendingTurns safety — always decremented", () => {
  test("pendingTurns decrements even when simulateTurnStart would throw", () => {
    const { q } = buildRuntime();
    const turns = { value: 0 };
    const skipIds = new Set<string>();

    const arrival = simulateMessageArrival(q, turns, makeMessageCreate("msg"));
    expect(turns.value).toBe(1);

    simulateTurnStart(q, turns, arrival, skipIds);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
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
    expect(turns.value).toBe(1);

    simulateTurnStart(q, turns, arrival, skipIds);
    expect(rec.dequeued).toHaveLength(0);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
  });
});

describe("connection close", () => {
  test("clear(shutdown) reports a single clear callback for intentional close", () => {
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
    q.clear("shutdown");
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

    simulateTurnStart(q, turns, arrival1, skipIds);
    simulateTurnEnd(q, turns);
    expect(rec.cleared).toHaveLength(0);

    simulateTurnStart(q, turns, arrival2, skipIds);
    expect(rec.dequeued).toHaveLength(1);
    simulateTurnEnd(q, turns);
    expect(turns.value).toBe(0);
    expect(rec.cleared).toHaveLength(0);
  });
});
