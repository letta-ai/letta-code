import { describe, expect, test } from "bun:test";
import { getListenerBlockedReason } from "@/websocket/helpers/listener-queue-adapter";
import { TurnLifecycle } from "@/websocket/listener/turn-lifecycle";

function createLifecycle(): TurnLifecycle {
  return new TurnLifecycle(() => "lease-1");
}

describe("getListenerBlockedReason", () => {
  test("returns null when idle", () => {
    const lifecycle = createLifecycle();
    expect(getListenerBlockedReason(lifecycle.snapshot(), 0)).toBeNull();
  });

  test("maps pending approvals while otherwise idle", () => {
    const lifecycle = createLifecycle();
    expect(getListenerBlockedReason(lifecycle.snapshot(), 2)).toBe(
      "pending_approvals",
    );
  });

  test("prioritizes cancellation over pending approvals", () => {
    const lifecycle = createLifecycle();
    lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });
    lifecycle.requestCancellation();

    expect(getListenerBlockedReason(lifecycle.snapshot(), 2)).toBe(
      "interrupt_in_progress",
    );
  });

  test("maps waiting-on-approval phase to pending approvals", () => {
    const lifecycle = createLifecycle();
    const lease = lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
    });
    lifecycle.setStatus(lease, "WAITING_ON_APPROVAL");

    expect(getListenerBlockedReason(lifecycle.snapshot(), 0)).toBe(
      "pending_approvals",
    );
  });

  test("maps command execution to command_running", () => {
    const lifecycle = createLifecycle();
    lifecycle.startCommand();

    expect(getListenerBlockedReason(lifecycle.snapshot(), 0)).toBe(
      "command_running",
    );
  });

  test.each([
    "SENDING_API_REQUEST",
    "RETRYING_API_REQUEST",
    "WAITING_FOR_API_RESPONSE",
    "PROCESSING_API_RESPONSE",
    "EXECUTING_CLIENT_SIDE_TOOL",
  ] as const)("maps active %s to streaming", (loopStatus) => {
    const lifecycle = createLifecycle();
    lifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp/worktree",
      initialStatus: loopStatus,
    });

    expect(getListenerBlockedReason(lifecycle.snapshot(), 0)).toBe("streaming");
  });
});
