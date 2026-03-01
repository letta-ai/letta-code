import { describe, expect, test } from "bun:test";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { DequeuedBatch } from "../../queue/queueRuntime";
import { QueueRuntime } from "../../queue/queueRuntime";

type QueueItemArrival = { isUserMessage: boolean; queueItemId?: string };

function makeMessageCreate(text: string): MessageCreate {
  return { role: "user", content: text } as unknown as MessageCreate;
}

/**
 * Mirrors listen-client arrival + turn-start/turn-end queue wiring.
 */
function simulateListenerScript(
  script: Array<"arrive_a" | "arrive_b" | "turn_a" | "turn_b">,
): DequeuedBatch[] {
  const dequeuedBatches: DequeuedBatch[] = [];
  const q = new QueueRuntime({
    maxItems: Infinity,
    callbacks: {
      onDequeued: (batch) => dequeuedBatches.push(batch),
    },
  });
  const pendingTurns = { value: 0 };
  const skipIds = new Set<string>();
  const arrivals: Record<"a" | "b", QueueItemArrival | undefined> = {
    a: undefined,
    b: undefined,
  };

  const messageByKey: Record<"a" | "b", MessageCreate> = {
    a: makeMessageCreate("a"),
    b: makeMessageCreate("b"),
  };

  for (const step of script) {
    if (step.startsWith("arrive_")) {
      const key = step.endsWith("_a") ? "a" : "b";
      const payload = messageByKey[key];
      const enqueued = q.enqueue({
        kind: "message",
        source: "user",
        content: payload.content,
      } as Parameters<typeof q.enqueue>[0]);
      arrivals[key] = {
        isUserMessage: true,
        queueItemId: enqueued?.id,
      };
      if (pendingTurns.value > 0) {
        q.tryDequeue("runtime_busy");
      }
      pendingTurns.value++;
      continue;
    }

    const key = step.endsWith("_a") ? "a" : "b";
    const arrival = arrivals[key];
    if (arrival?.isUserMessage && arrival.queueItemId) {
      if (skipIds.has(arrival.queueItemId)) {
        skipIds.delete(arrival.queueItemId);
      } else {
        const batch = q.tryDequeue(null);
        if (batch) {
          for (const item of batch.items) {
            if (item.id !== arrival.queueItemId) {
              skipIds.add(item.id);
            }
          }
        }
      }
    }
    pendingTurns.value--;
    if (pendingTurns.value === 0) {
      q.resetBlockedState();
    }
  }

  return dequeuedBatches;
}

/**
 * Mirrors TUI queue wiring at the QueueRuntime boundary for the same scripts.
 */
function simulateTuiScript(
  script: Array<"arrive_a" | "arrive_b" | "turn_a" | "turn_b">,
): DequeuedBatch[] {
  const dequeuedBatches: DequeuedBatch[] = [];
  const q = new QueueRuntime({
    maxItems: Infinity,
    callbacks: {
      onDequeued: (batch) => dequeuedBatches.push(batch),
    },
  });
  const pendingTurns = { value: 0 };
  const arrivals: Record<"a" | "b", boolean> = { a: false, b: false };

  for (const step of script) {
    if (step.startsWith("arrive_")) {
      const key = step.endsWith("_a") ? "a" : "b";
      q.enqueue({
        kind: "message",
        source: "user",
        content: key,
      } as Parameters<typeof q.enqueue>[0]);
      arrivals[key] = true;
      pendingTurns.value++;
      continue;
    }

    // TUI drains all currently pending queue items when turn processing starts.
    if (pendingTurns.value > 0) {
      q.consumeItems(pendingTurns.value);
      pendingTurns.value = 0;
    }
  }

  return dequeuedBatches;
}

function simplifyProgression(batches: DequeuedBatch[]) {
  return batches.map((batch) => ({
    batchId: batch.batchId,
    mergedCount: batch.mergedCount,
  }));
}

describe("listener/TUI queue lifecycle parity", () => {
  test("rapid two arrivals while busy produce identical batch progression", () => {
    const script: Array<"arrive_a" | "arrive_b" | "turn_a" | "turn_b"> = [
      "arrive_a",
      "arrive_b",
      "turn_a",
      "turn_b",
    ];

    const listener = simplifyProgression(simulateListenerScript(script));
    const tui = simplifyProgression(simulateTuiScript(script));

    expect(listener).toEqual([{ batchId: "batch-1", mergedCount: 2 }]);
    expect(tui).toEqual(listener);
  });

  test("sequential arrivals when idle produce identical progression", () => {
    const script: Array<"arrive_a" | "arrive_b" | "turn_a" | "turn_b"> = [
      "arrive_a",
      "turn_a",
      "arrive_b",
      "turn_b",
    ];

    const listener = simplifyProgression(simulateListenerScript(script));
    const tui = simplifyProgression(simulateTuiScript(script));

    expect(listener).toEqual([
      { batchId: "batch-1", mergedCount: 1 },
      { batchId: "batch-2", mergedCount: 1 },
    ]);
    expect(tui).toEqual(listener);
  });
});
