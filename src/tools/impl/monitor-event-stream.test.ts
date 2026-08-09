import { describe, expect, test } from "bun:test";
import {
  createMonitorEventStream,
  MONITOR_EVENT_BATCH_CHARS,
  MONITOR_EVENT_BUFFER_CHARS,
  MONITOR_EVENT_LINE_CHARS,
} from "./monitor-event-stream";

function createFakeScheduler() {
  let scheduled: (() => void) | undefined;
  return {
    schedule(callback: () => void): () => void {
      scheduled = callback;
      return () => {
        if (scheduled === callback) scheduled = undefined;
      };
    },
    flush(): void {
      const callback = scheduled;
      scheduled = undefined;
      callback?.();
    },
  };
}

describe("monitor event stream", () => {
  test("batches complete lines and flushes a final partial line", () => {
    const emitted: string[] = [];
    const scheduler = createFakeScheduler();
    const stream = createMonitorEventStream({
      emit: (event) => emitted.push(event),
      stopSource: () => {},
      scheduleFlush: scheduler.schedule,
    });

    stream.onData(" first \nsecond\npartial");
    scheduler.flush();
    expect(emitted).toEqual(["first\nsecond"]);

    stream.finish();
    expect(emitted).toEqual(["first\nsecond", "partial"]);
  });

  test("caps individual lines, batches, and the partial-line buffer", () => {
    const emitted: string[] = [];
    const scheduler = createFakeScheduler();
    const stream = createMonitorEventStream({
      emit: (event) => emitted.push(event),
      stopSource: () => {},
      scheduleFlush: scheduler.schedule,
    });

    stream.onData(`${"x".repeat(MONITOR_EVENT_LINE_CHARS + 10)}\n`);
    scheduler.flush();
    expect(emitted[0]).toBe(
      `${"x".repeat(MONITOR_EVENT_LINE_CHARS)}...(truncated)`,
    );

    for (let index = 0; index < 10; index += 1) {
      stream.onData(`${String(index).repeat(MONITOR_EVENT_LINE_CHARS)}\n`);
    }
    scheduler.flush();
    expect(emitted[1]?.length).toBe(
      MONITOR_EVENT_BATCH_CHARS + "\n...(truncated)".length,
    );

    const secondStream = createMonitorEventStream({
      emit: (event) => emitted.push(event),
      stopSource: () => {},
      scheduleFlush: scheduler.schedule,
    });
    secondStream.onData(
      `${"a".repeat(100)}${"b".repeat(MONITOR_EVENT_BUFFER_CHARS)}\n`,
    );
    scheduler.flush();
    expect(emitted.at(-1)?.startsWith("b")).toBe(true);
  });

  test("reports suppressed events when a rate-limit token refills", () => {
    const emitted: string[] = [];
    const scheduler = createFakeScheduler();
    let now = 0;
    const stream = createMonitorEventStream({
      emit: (event) => emitted.push(event),
      stopSource: () => {},
      now: () => now,
      scheduleFlush: scheduler.schedule,
    });

    for (let index = 0; index < 11; index += 1) {
      stream.onData(`event ${index}\n`);
      scheduler.flush();
    }
    expect(emitted).toHaveLength(10);

    now = 2000;
    stream.onData("after refill\n");
    scheduler.flush();
    expect(emitted.slice(-2)).toEqual([
      "[1 events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]",
      "after refill",
    ]);
  });

  test("stops after output stays above the rate limit for 30 seconds", () => {
    const emitted: string[] = [];
    const scheduler = createFakeScheduler();
    let now = 0;
    let stopCount = 0;
    const stream = createMonitorEventStream({
      emit: (event) => emitted.push(event),
      stopSource: () => {
        stopCount += 1;
      },
      now: () => now,
      scheduleFlush: scheduler.schedule,
    });

    while (!stream.isStopped() && now < 40_000) {
      stream.onData(`event at ${now}\n`);
      scheduler.flush();
      now += 100;
    }

    expect(stopCount).toBe(1);
    expect(stream.isStopped()).toBe(true);
    expect(emitted.at(-1)).toContain("Monitor stopped — too much output");
  });
});
