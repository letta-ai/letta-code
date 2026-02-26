/**
 * Unit tests for getTuiBlockedReason() in tuiQueueAdapter.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  getTuiBlockedReason,
  type TuiQueueGatingConditions,
} from "../../cli/helpers/tuiQueueAdapter";

const allClear: TuiQueueGatingConditions = {
  streaming: false,
  isExecutingTool: false,
  commandRunning: false,
  pendingApprovalsLen: 0,
  queuedOverlayAction: false,
  anySelectorOpen: false,
  waitingForQueueCancel: false,
  userCancelled: false,
  abortControllerActive: false,
};

describe("getTuiBlockedReason", () => {
  test("returns null when all conditions clear", () => {
    expect(getTuiBlockedReason(allClear)).toBeNull();
  });

  test("streaming → 'streaming'", () => {
    expect(getTuiBlockedReason({ ...allClear, streaming: true })).toBe(
      "streaming",
    );
  });

  test("isExecutingTool → 'streaming'", () => {
    expect(getTuiBlockedReason({ ...allClear, isExecutingTool: true })).toBe(
      "streaming",
    );
  });

  test("abortControllerActive → 'streaming'", () => {
    expect(
      getTuiBlockedReason({ ...allClear, abortControllerActive: true }),
    ).toBe("streaming");
  });

  test("commandRunning → 'command_running'", () => {
    expect(getTuiBlockedReason({ ...allClear, commandRunning: true })).toBe(
      "command_running",
    );
  });

  test("pendingApprovalsLen > 0 → 'pending_approvals'", () => {
    expect(getTuiBlockedReason({ ...allClear, pendingApprovalsLen: 3 })).toBe(
      "pending_approvals",
    );
  });

  test("queuedOverlayAction → 'overlay_open'", () => {
    expect(
      getTuiBlockedReason({ ...allClear, queuedOverlayAction: true }),
    ).toBe("overlay_open");
  });

  test("anySelectorOpen → 'overlay_open'", () => {
    expect(getTuiBlockedReason({ ...allClear, anySelectorOpen: true })).toBe(
      "overlay_open",
    );
  });

  test("waitingForQueueCancel → 'interrupt_in_progress'", () => {
    expect(
      getTuiBlockedReason({ ...allClear, waitingForQueueCancel: true }),
    ).toBe("interrupt_in_progress");
  });

  test("userCancelled → 'interrupt_in_progress'", () => {
    expect(getTuiBlockedReason({ ...allClear, userCancelled: true })).toBe(
      "interrupt_in_progress",
    );
  });

  describe("priority order (first match wins)", () => {
    test("interrupt_in_progress beats streaming", () => {
      expect(
        getTuiBlockedReason({
          ...allClear,
          streaming: true,
          userCancelled: true,
        }),
      ).toBe("interrupt_in_progress");
    });

    test("interrupt_in_progress beats pending_approvals", () => {
      expect(
        getTuiBlockedReason({
          ...allClear,
          pendingApprovalsLen: 2,
          waitingForQueueCancel: true,
        }),
      ).toBe("interrupt_in_progress");
    });

    test("pending_approvals beats overlay_open", () => {
      expect(
        getTuiBlockedReason({
          ...allClear,
          pendingApprovalsLen: 1,
          anySelectorOpen: true,
        }),
      ).toBe("pending_approvals");
    });

    test("overlay_open beats command_running", () => {
      expect(
        getTuiBlockedReason({
          ...allClear,
          commandRunning: true,
          queuedOverlayAction: true,
        }),
      ).toBe("overlay_open");
    });

    test("command_running beats streaming", () => {
      expect(
        getTuiBlockedReason({
          ...allClear,
          streaming: true,
          commandRunning: true,
        }),
      ).toBe("command_running");
    });

    test("all conditions active → interrupt_in_progress (highest priority)", () => {
      expect(
        getTuiBlockedReason({
          streaming: true,
          isExecutingTool: true,
          commandRunning: true,
          pendingApprovalsLen: 1,
          queuedOverlayAction: true,
          anySelectorOpen: true,
          waitingForQueueCancel: true,
          userCancelled: true,
          abortControllerActive: true,
        }),
      ).toBe("interrupt_in_progress");
    });
  });
});
