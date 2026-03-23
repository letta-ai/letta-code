import { describe, expect, test } from "bun:test";
import { getListenerBlockedReason } from "../../websocket/helpers/listenerQueueAdapter";

const allClear = {
  loopStatus: "WAITING_ON_INPUT",
  isProcessing: false,
  pendingApprovalsLen: 0,
  cancelRequested: false,
  isRecoveringApprovals: false,
} as const;

describe("getListenerBlockedReason", () => {
  test("returns null when unblocked", () => {
    expect(getListenerBlockedReason(allClear)).toBeNull();
  });

  test("prioritizes pending approvals", () => {
    expect(
      getListenerBlockedReason({ ...allClear, pendingApprovalsLen: 2 }),
    ).toBe("pending_approvals");
  });

  test("prioritizes interrupt over approval and streaming phases", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        cancelRequested: true,
        pendingApprovalsLen: 2,
        loopStatus: "PROCESSING_API_RESPONSE",
        isProcessing: true,
      }),
    ).toBe("interrupt_in_progress");
  });

  test("maps recoveries to runtime busy", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        isRecoveringApprovals: true,
        loopStatus: "EXECUTING_COMMAND",
      }),
    ).toBe("runtime_busy");
  });

  test("maps waiting-on-approval phase to pending approvals", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        loopStatus: "WAITING_ON_APPROVAL",
      }),
    ).toBe("pending_approvals");
  });

  test("maps command execution to command_running", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        loopStatus: "EXECUTING_COMMAND",
      }),
    ).toBe("command_running");
  });

  test.each([
    "SENDING_API_REQUEST",
    "RETRYING_API_REQUEST",
    "WAITING_FOR_API_RESPONSE",
    "PROCESSING_API_RESPONSE",
    "EXECUTING_CLIENT_SIDE_TOOL",
  ] as const)("maps %s to streaming", (loopStatus) => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        loopStatus,
      }),
    ).toBe("streaming");
  });

  test("falls back to runtime busy when processing without a specific phase", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        isProcessing: true,
      }),
    ).toBe("runtime_busy");
  });
});
