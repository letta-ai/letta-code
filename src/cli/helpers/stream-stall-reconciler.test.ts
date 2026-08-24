import { afterEach, describe, expect, test } from "bun:test";
import { createStreamStallReconciler } from "@/cli/helpers/stream-stall-reconciler";

/**
 * Regression tests for the mid-stream stall reconciler.
 *
 * Production failure mode: a turn's message stream goes silent BEFORE the
 * terminal SSE sequence (dead socket, lost frames). The run completes
 * server-side — e.g. with requires_approval and a pending approval request —
 * but the client iterator neither yields nor throws, so the turn wedges in
 * PROCESSING_API_RESPONSE with zero executing tools and the approval never
 * surfaces. The reconciler detects sustained silence (the server pings every
 * ~20s, so silence means a dead read), confirms the run ended server-side,
 * and aborts the dead read so the resume path replays the lost tail.
 */

const originalInterval = process.env.LETTA_STREAM_STALL_RECONCILE_MS;
const originalStatusTimeout = process.env.LETTA_STREAM_STALL_STATUS_TIMEOUT_MS;

afterEach(() => {
  if (originalInterval === undefined) {
    delete process.env.LETTA_STREAM_STALL_RECONCILE_MS;
  } else {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = originalInterval;
  }
  if (originalStatusTimeout === undefined) {
    delete process.env.LETTA_STREAM_STALL_STATUS_TIMEOUT_MS;
  } else {
    process.env.LETTA_STREAM_STALL_STATUS_TIMEOUT_MS = originalStatusTimeout;
  }
});

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ReconcilerHarness = {
  reconciler: ReturnType<typeof createStreamStallReconciler>;
  aborts: () => number;
  statusCalls: () => number;
};

function makeReconciler(options: {
  runId?: string | null;
  stopReason?: string | null;
  canResumeWithoutRunId?: boolean;
  status?: string | null | (() => string | null);
  statusError?: boolean;
}): ReconcilerHarness {
  let abortCount = 0;
  let statusCallCount = 0;
  const reconciler = createStreamStallReconciler({
    getRunId: () => options.runId ?? null,
    getStopReason: () => options.stopReason ?? null,
    canResumeWithoutRunId: () => options.canResumeWithoutRunId ?? false,
    retrieveRunStatus: async () => {
      statusCallCount += 1;
      if (options.statusError) {
        throw new Error("lookup failed");
      }
      return typeof options.status === "function"
        ? options.status()
        : (options.status ?? null);
    },
    abortHttpRead: () => {
      abortCount += 1;
    },
  });
  return {
    reconciler,
    aborts: () => abortCount,
    statusCalls: () => statusCallCount,
  };
}

describe("createStreamStallReconciler", () => {
  test("aborts the dead read when the run completed server-side", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({ runId: "run-1", status: "completed" });
    harness.reconciler.arm();
    await waitMs(60);
    expect(harness.aborts()).toBe(1);
    expect(harness.reconciler.fired()).toBe(true);
    harness.reconciler.clear();
  });

  test("keeps waiting while the run is still active server-side", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({ runId: "run-1", status: "running" });
    harness.reconciler.arm();
    await waitMs(70);
    expect(harness.aborts()).toBe(0);
    expect(harness.reconciler.fired()).toBe(false);
    // It re-armed and kept checking rather than giving up.
    expect(harness.statusCalls()).toBeGreaterThanOrEqual(2);
    harness.reconciler.clear();
  });

  test("reconnects when the status lookup fails", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({ runId: "run-1", statusError: true });
    harness.reconciler.arm();
    await waitMs(50);
    expect(harness.aborts()).toBe(1);
    expect(harness.statusCalls()).toBe(1);
    harness.reconciler.clear();
  });

  test("keeps waiting without a run id or OTID", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({ runId: null, status: "completed" });
    harness.reconciler.arm();
    await waitMs(50);
    expect(harness.aborts()).toBe(0);
    expect(harness.statusCalls()).toBe(0);
    harness.reconciler.clear();
  });

  test("reconnects without a run id when OTID replay is available", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({
      runId: null,
      canResumeWithoutRunId: true,
    });
    harness.reconciler.arm();
    await waitMs(50);
    expect(harness.aborts()).toBe(1);
    expect(harness.statusCalls()).toBe(0);
    harness.reconciler.clear();
  });

  test("times out a hung status lookup before reconnecting", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "10";
    process.env.LETTA_STREAM_STALL_STATUS_TIMEOUT_MS = "15";
    let abortCount = 0;
    let statusSignalAborted = false;
    const reconciler = createStreamStallReconciler({
      getRunId: () => "run-1",
      getStopReason: () => null,
      canResumeWithoutRunId: () => false,
      retrieveRunStatus: async (_runId, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              statusSignalAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        }),
      abortHttpRead: () => {
        abortCount += 1;
      },
    });

    reconciler.arm();
    await waitMs(50);
    expect(statusSignalAborted).toBe(true);
    expect(abortCount).toBe(1);
    reconciler.clear();
  });

  test("defers to the terminal-EOF guard once stop_reason arrived", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({
      runId: "run-1",
      stopReason: "end_turn",
      status: "completed",
    });
    harness.reconciler.arm();
    await waitMs(60);
    expect(harness.aborts()).toBe(0);
    expect(harness.statusCalls()).toBe(0);
    harness.reconciler.clear();
  });

  test("chunk arrival re-arms instead of firing", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "40";
    const harness = makeReconciler({ runId: "run-1", status: "completed" });
    harness.reconciler.arm();
    await waitMs(25);
    harness.reconciler.arm(); // chunk arrived
    await waitMs(25);
    // 50ms total elapsed but never 40ms of continuous silence.
    expect(harness.aborts()).toBe(0);
    harness.reconciler.clear();
  });

  test("clear() cancels a pending timer", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    const harness = makeReconciler({ runId: "run-1", status: "completed" });
    harness.reconciler.arm();
    harness.reconciler.clear();
    await waitMs(50);
    expect(harness.aborts()).toBe(0);
    expect(harness.statusCalls()).toBe(0);
  });

  test("does not double-fire after aborting once", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "15";
    const harness = makeReconciler({ runId: "run-1", status: "completed" });
    harness.reconciler.arm();
    await waitMs(40);
    harness.reconciler.arm(); // stray re-arm after firing must be a no-op
    await waitMs(40);
    expect(harness.aborts()).toBe(1);
    harness.reconciler.clear();
  });

  test("activity during a status lookup invalidates its result", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    let resolveStatus!: (status: string) => void;
    const statusPromise = new Promise<string>((resolve) => {
      resolveStatus = resolve;
    });
    let abortCount = 0;
    const reconciler = createStreamStallReconciler({
      getRunId: () => "run-1",
      getStopReason: () => null,
      canResumeWithoutRunId: () => false,
      retrieveRunStatus: async () => statusPromise,
      abortHttpRead: () => {
        abortCount += 1;
      },
    });

    reconciler.arm();
    await waitMs(25);
    reconciler.arm();
    resolveStatus("completed");
    await waitMs(10);
    expect(abortCount).toBe(0);
    reconciler.clear();
  });

  test("status resolved after stop_reason arrival does not abort", async () => {
    process.env.LETTA_STREAM_STALL_RECONCILE_MS = "20";
    let stopReason: string | null = null;
    let abortCount = 0;
    const reconciler = createStreamStallReconciler({
      getRunId: () => "run-1",
      getStopReason: () => stopReason,
      canResumeWithoutRunId: () => false,
      retrieveRunStatus: async () => {
        // The terminal chunk lands while the status lookup is in flight.
        stopReason = "requires_approval";
        return "completed";
      },
      abortHttpRead: () => {
        abortCount += 1;
      },
    });
    reconciler.arm();
    await waitMs(60);
    expect(abortCount).toBe(0);
    reconciler.clear();
  });
});
