import { describe, expect, test } from "bun:test";
import {
  finishTuiTurn,
  settleTuiInterrupt,
} from "@/cli/helpers/tui-turn-lifecycle";

function harness(overrides?: {
  processing?: number;
  queueLength?: number;
  controller?: AbortController | null;
  generation?: number;
}) {
  const controller =
    overrides?.controller === undefined
      ? new AbortController()
      : overrides.controller;
  const abortControllerRef = { current: controller };
  const processingConversationRef = { current: overrides?.processing ?? 1 };
  const releasedGenerationRef = { current: null as number | null };
  const staleTurnUnwindingRef = { current: true };
  const userCancelledRef = { current: true };
  const interruptRequested: boolean[] = [];
  let epochBumps = 0;
  return {
    controller,
    abortControllerRef,
    processingConversationRef,
    releasedGenerationRef,
    staleTurnUnwindingRef,
    conversationGenerationRef: {
      current: overrides?.generation ?? 0,
    },
    userCancelledRef,
    interruptRequested,
    bumps: () => epochBumps,
    args: {
      abortControllerRef,
      processingConversationRef,
      releasedGenerationRef,
      staleTurnUnwindingRef,
      turnGeneration: 0,
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

  test("forced release allows a new turn and ignores the old turn's late finally", () => {
    const h = harness();
    settleTuiInterrupt({
      ...h.args,
      queueLength: 0,
      bumpDequeueEpoch: () => {},
      forceRelease: {
        abortControllerRef: h.abortControllerRef,
        processingConversationRef: h.processingConversationRef,
        conversationGenerationRef: h.conversationGenerationRef,
        releasedGenerationRef: h.releasedGenerationRef,
      },
    });

    const replacement = new AbortController();
    h.abortControllerRef.current = replacement;
    h.processingConversationRef.current = 1;
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: h.controller,
    });

    expect(h.abortControllerRef.current).toBe(replacement);
    expect(h.processingConversationRef.current).toBe(1);
    expect(h.conversationGenerationRef.current).toBe(1);
    expect(h.staleTurnUnwindingRef.current).toBe(false);
  });

  test("overlapping stale turns still settle after a plain Esc", () => {
    const h = harness({ processing: 2 });
    const nested = new AbortController();
    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: nested,
    });
    expect(h.processingConversationRef.current).toBe(1);
    expect(h.userCancelledRef.current).toBe(true);

    finishTuiTurn({
      ...h.args,
      isStale: true,
      turnAbortController: h.controller,
    });
    expect(h.processingConversationRef.current).toBe(0);
    expect(h.userCancelledRef.current).toBe(false);
    expect(h.interruptRequested).toEqual([false]);
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
