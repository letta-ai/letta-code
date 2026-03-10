import { describe, expect, test } from "bun:test";
import { getListenerBlockedReason } from "../../websocket/helpers/listenerQueueAdapter";

const allClear = {
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

  test("prioritizes interrupt over runtime busy", () => {
    expect(
      getListenerBlockedReason({
        ...allClear,
        cancelRequested: true,
        isProcessing: true,
      }),
    ).toBe("interrupt_in_progress");
  });

  test("maps recoveries to runtime busy", () => {
    expect(
      getListenerBlockedReason({ ...allClear, isRecoveringApprovals: true }),
    ).toBe("runtime_busy");
  });

  test("maps active processing to runtime busy", () => {
    expect(getListenerBlockedReason({ ...allClear, isProcessing: true })).toBe(
      "runtime_busy",
    );
  });
});
