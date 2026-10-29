import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { MAX_QUEUED_EVENTS, TelemetryEventQueueCap } from "./event-queue";

describe("TelemetryEventQueueCap", () => {
  const originalLettaDebug = process.env.LETTA_DEBUG;

  afterEach(() => {
    if (originalLettaDebug === undefined) {
      delete process.env.LETTA_DEBUG;
    } else {
      process.env.LETTA_DEBUG = originalLettaDebug;
    }
  });

  test("leaves queues at or under the cap untouched", () => {
    const cap = new TelemetryEventQueueCap();
    const queue = [1, 2, 3];
    expect(cap.enforce(queue)).toBe(0);
    expect(queue).toEqual([1, 2, 3]);

    const atCap = Array.from({ length: MAX_QUEUED_EVENTS }, (_, i) => i);
    expect(cap.enforce(atCap)).toBe(0);
    expect(atCap).toHaveLength(MAX_QUEUED_EVENTS);
    expect(atCap[0]).toBe(0);
  });

  test("drops the oldest events when the queue exceeds the cap", () => {
    const cap = new TelemetryEventQueueCap();
    const overflow = 5;
    const queue = Array.from(
      { length: MAX_QUEUED_EVENTS + overflow },
      (_, i) => i,
    );
    expect(cap.enforce(queue)).toBe(overflow);
    expect(queue).toHaveLength(MAX_QUEUED_EVENTS);
    // Oldest events (lowest indices) are dropped; order of the rest is kept.
    expect(queue[0]).toBe(overflow);
    expect(queue[queue.length - 1]).toBe(MAX_QUEUED_EVENTS + overflow - 1);
  });

  test("emits at most one throttled debug line per interval", () => {
    process.env.LETTA_DEBUG = "1";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const cap = new TelemetryEventQueueCap();
      const t0 = 1_000_000;
      const overflowing = () =>
        new Array<number>(MAX_QUEUED_EVENTS + 1).fill(0);

      // First overflow logs immediately.
      cap.enforce(overflowing(), t0);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Further overflows within the interval stay silent.
      cap.enforce(overflowing(), t0 + 1);
      cap.enforce(overflowing(), t0 + 30_000);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // After the interval the next overflow logs again.
      cap.enforce(overflowing(), t0 + 120_000);
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
