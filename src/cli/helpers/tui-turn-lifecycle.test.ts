import { describe, expect, test } from "bun:test";
import {
  finishTuiTurn,
  settleTuiInterrupt,
} from "@/cli/helpers/tui-turn-lifecycle";

function harness(overrides?: {
  processing?: number;
  queueLength?: number;
  controller?: AbortController | null;
}) {
  const controller =
    overrides?.controller === undefined
      ? new AbortController()
      : overrides.controller;
  const abortControllerRef = { current: controller };
  const processingConversationRef = { current: overrides?.processing ?? 1 };
  const userCancelledRef = { current: true };
  const interruptRequested: boolean[] = [];
  let epochBumps = 0;
  return {
    controller,
    abortControllerRef,
    processingConversationRef,
    userCancelledRef,
    interruptRequested,
    bumps: () => epochBumps,
    args: {
      abortControllerRef,
      processingConversationRef,
      userCancelledRef,
      setInterruptRequested: (value: boolean) => {
        interruptRequested.push(value);
      },
      queueLength: () => overrides?.queueLength ?? 1,
      bumpDequeueEpoch: () => {
        epochBumps += 1;
      },
    },
  };
}

describe("settleTuiInterrupt", () => {
  test("clears the cancel guard and interrupt flag, bumps when work is queued", () => {
    const userCancelledRef = { current: true };
    const flags: boolean[] = [];
    let bumps = 0;
    settleTuiInterrupt({
      userCancelledRef,
      setInterruptRequested: (v) => flags.push(v),
      queueLength: 2,
      bumpDequeueEpoch: () => {
        bumps += 1;
      },
    });
    expect(userCancelledRef.current).toBe(false);
    expect(flags).toEqual([false]);
    expect(bumps).toBe(1);
  });

  test("does not bump the epoch when the queue is empty", () => {
    const userCancelledRef = { current: true };
    let bumps = 0;
    settleTuiInterrupt({
      userCancelledRef,
      setInterruptRequested: () => {},
      queueLength: 0,
      bumpDequeueEpoch: () => {
        bumps += 1;
      },
    });
    expect(userCancelledRef.current).toBe(false);
    expect(bumps).toBe(0);
  });
});

describe("finishTuiTurn — normal completion", () => {
  test("clears its own controller, decrements, and wakes dequeue when queued", () => {
    const h = harness();
    finishTuiTurn({
      ...h.args,
      isStale: false,
      turnAbortController: h.controller,
    });
    expect(h.abortControllerRef.current).toBeNull();
    expect(h.processingConversationRef.current).toBe(0);
    expect(h.bumps()).toBe(1);
    // Not an interrupt: the cancel guard is left alone.
    expect(h.userCancelledRef.current).toBe(true);
    expect(h.interruptRequested).toEqual([]);
  });

  test("does not bump when nothing is queued", () => {
    const h = harness({ queueLength: 0 });
    finishTuiTurn({
      ...h.args,
      isStale: false,
      turnAbortController: h.controller,
    });
    expect(h.bumps()).toBe(0);
  });
});

describe("finishTuiTurn — interrupted (stale) turn", () => {
  test("settles the interrupt once the last in-flight call unwinds", () => {
    const h = harness();
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: h.controller,
    });
    expect(h.abortControllerRef.current).toBeNull();
    expect(h.processingConversationRef.current).toBe(0);
    expect(h.userCancelledRef.current).toBe(false);
    expect(h.interruptRequested).toEqual([false]);
    expect(h.bumps()).toBe(1);
  });

  test("a nested stale call does not settle while the outer call is in flight", () => {
    const h = harness({ processing: 2 });
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: h.controller,
    });
    expect(h.processingConversationRef.current).toBe(1);
    expect(h.userCancelledRef.current).toBe(true);
    expect(h.interruptRequested).toEqual([]);
    expect(h.bumps()).toBe(0);
  });

  test("a stale turn unwinding late never clears a replacement turn's controller", () => {
    const replacement = new AbortController();
    const h = harness({ controller: replacement, processing: 2 });
    const stale = new AbortController();
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: stale,
    });
    expect(h.abortControllerRef.current).toBe(replacement);
  });

  test("the processing count never goes negative", () => {
    const h = harness({ processing: 0, queueLength: 0 });
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: h.controller,
    });
    expect(h.processingConversationRef.current).toBe(0);
    expect(h.userCancelledRef.current).toBe(false);
  });
});
