import { describe, expect, test } from "bun:test";
import { TurnLifecycle } from "./turn-lifecycle";

describe("TurnLifecycle", () => {
  test("projects a coherent active turn from one owned state", () => {
    const lifecycle = new TurnLifecycle(() => "lease-1");
    const lease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });

    expect(lifecycle.kind).toBe("active");
    expect(lifecycle.isProcessing).toBe(true);
    expect(lifecycle.cancelRequested).toBe(false);
    expect(lifecycle.loopStatus).toBe("SENDING_API_REQUEST");
    expect(lifecycle.activeWorkingDirectory).toBe("/tmp/worktree");
    expect(lifecycle.currentLease?.signal).toBe(lease.signal);

    expect(lifecycle.setRunId(lease, "run-1")).toBe(true);
    expect(lifecycle.setExecutingToolCallIds(lease, ["tool-1", "tool-2"])).toBe(
      true,
    );
    expect(lifecycle.setStatus(lease, "EXECUTING_CLIENT_SIDE_TOOL")).toBe(true);
    expect(lifecycle.activeRunId).toBe("run-1");
    expect(lifecycle.snapshot()).toMatchObject({
      kind: "active",
      executingToolCallIds: ["tool-1", "tool-2"],
    });
  });

  test("cancellation keeps the lease blocked while projecting idle UI state", () => {
    const lifecycle = new TurnLifecycle(() => "lease-1");
    const lease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });
    lifecycle.setRunId(lease, "run-1");
    lifecycle.setExecutingToolCallIds(lease, ["tool-1"]);

    const cancellation = lifecycle.requestCancellation();

    expect(cancellation).toMatchObject({
      transitioned: true,
      lease,
      runId: "run-1",
      executingToolCallIds: ["tool-1"],
    });
    expect(lease.signal.aborted).toBe(true);
    expect(lifecycle.kind).toBe("cancelling");
    expect(lifecycle.isProcessing).toBe(false);
    expect(lifecycle.cancelRequested).toBe(true);
    expect(lifecycle.loopStatus).toBe("WAITING_ON_INPUT");
    expect(lifecycle.activeRunId).toBeNull();
    expect(lifecycle.currentLease?.signal.aborted).toBe(true);

    expect(lifecycle.finish(lease, "cancelled")).toEqual({
      finished: true,
      previousKind: "cancelling",
      runId: "run-1",
    });
    expect(lifecycle.kind).toBe("idle");
    expect(lifecycle.cancelRequested).toBe(false);
    expect(lifecycle.lastStopReason).toBe("cancelled");
  });

  test("reset invalidates stale async owners before a replacement turn", () => {
    let nextId = 0;
    const lifecycle = new TurnLifecycle(() => `lease-${++nextId}`);
    const staleLease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/old",
    });

    expect(lifecycle.reset("cancelled").finished).toBe(true);
    const currentLease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/new",
    });

    expect(lifecycle.setRunId(staleLease, "stale-run")).toBe(false);
    expect(lifecycle.setStatus(staleLease, "PROCESSING_API_RESPONSE")).toBe(
      false,
    );
    expect(lifecycle.finish(staleLease, "error").finished).toBe(false);
    expect(lifecycle.isCurrent(currentLease)).toBe(true);
    expect(lifecycle.activeWorkingDirectory).toBe("/tmp/new");
    expect(lifecycle.lastStopReason).toBeNull();
  });

  test("finishes a lease exactly once", () => {
    const lifecycle = new TurnLifecycle(() => "lease-1");
    const lease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });

    expect(lifecycle.finish(lease, "end_turn").finished).toBe(true);
    expect(lifecycle.finish(lease, "error").finished).toBe(false);
    expect(lifecycle.kind).toBe("idle");
    expect(lifecycle.lastStopReason).toBe("end_turn");
  });

  test("rejects overlapping active turn ownership", () => {
    const lifecycle = new TurnLifecycle(() => "lease-1");
    lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });

    expect(() =>
      lifecycle.begin({
        origin: "message",
        workingDirectory: "/tmp/other",
      }),
    ).toThrow("Cannot begin a turn while lifecycle is active");
  });

  test("a turn atomically takes ownership from a tracked command", () => {
    const lifecycle = new TurnLifecycle(() => "lease-1");

    expect(lifecycle.startCommand()).toBe(true);
    expect(lifecycle.kind).toBe("command");
    expect(lifecycle.loopStatus).toBe("EXECUTING_COMMAND");
    expect(() =>
      lifecycle.begin({
        origin: "message",
        workingDirectory: "/tmp/worktree",
      }),
    ).not.toThrow();
    expect(lifecycle.startCommand()).toBe(false);
  });
});
