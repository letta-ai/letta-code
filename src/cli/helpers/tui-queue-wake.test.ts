import { describe, expect, test } from "bun:test";
import { getTuiBlockedReason } from "@/cli/helpers/tui-queue-adapter";
import { settleTuiInterruptQueueGuard } from "@/cli/helpers/tui-queue-wake";
import { QueueRuntime } from "@/queue/queue-runtime";

function enqueueTaskNotification(q: QueueRuntime): void {
  q.enqueue({
    kind: "task_notification",
    source: "task_notification",
    text: "<task_notification/>",
  } as Parameters<typeof q.enqueue>[0]);
}

describe("settleTuiInterruptQueueGuard", () => {
  test("clears the cancel guard and bumps the epoch when work is queued", () => {
    const userCancelledRef = { current: true };
    let epoch = 0;
    settleTuiInterruptQueueGuard({
      userCancelledRef,
      queueLength: 1,
      bumpDequeueEpoch: () => {
        epoch += 1;
      },
    });
    expect(userCancelledRef.current).toBe(false);
    expect(epoch).toBe(1);
  });

  test("clears the cancel guard without bumping when the queue is empty", () => {
    const userCancelledRef = { current: true };
    let epoch = 0;
    settleTuiInterruptQueueGuard({
      userCancelledRef,
      queueLength: 0,
      bumpDequeueEpoch: () => {
        epoch += 1;
      },
    });
    expect(userCancelledRef.current).toBe(false);
    expect(epoch).toBe(0);
  });
});

describe("Esc then idle drain (issue 4168)", () => {
  test("a Monitor notification queued during interrupt drains after the guard settles", () => {
    const q = new QueueRuntime();
    enqueueTaskNotification(q);

    const blockedWhileCancelling = getTuiBlockedReason({
      streaming: false,
      isExecutingTool: false,
      commandRunning: false,
      pendingApprovalsLen: 0,
      queuedOverlayAction: false,
      anySelectorOpen: false,
      waitingForQueueCancel: false,
      userCancelled: true,
      abortControllerActive: false,
    });
    expect(blockedWhileCancelling).toBe("interrupt_in_progress");
    q.tryDequeue(blockedWhileCancelling);
    expect(q.length).toBe(1);

    const userCancelledRef = { current: true };
    let epoch = 0;
    settleTuiInterruptQueueGuard({
      userCancelledRef,
      queueLength: q.length,
      bumpDequeueEpoch: () => {
        epoch += 1;
      },
    });

    const blockedAfterSettle = getTuiBlockedReason({
      streaming: false,
      isExecutingTool: false,
      commandRunning: false,
      pendingApprovalsLen: 0,
      queuedOverlayAction: false,
      anySelectorOpen: false,
      waitingForQueueCancel: false,
      userCancelled: userCancelledRef.current,
      abortControllerActive: false,
    });
    expect(blockedAfterSettle).toBeNull();
    expect(epoch).toBe(1);

    const batch = q.consumeItems(q.length);
    expect(batch?.items).toHaveLength(1);
    expect(batch?.items[0]?.kind).toBe("task_notification");
    expect(q.length).toBe(0);
  });
});
