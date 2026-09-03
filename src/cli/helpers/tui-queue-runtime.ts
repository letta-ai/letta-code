import type { Dispatch, SetStateAction } from "react";
import { toQueuedMsg } from "@/cli/helpers/queued-message-parts";
import { QueueRuntime } from "@/queue/queue-runtime";
import { debugLog } from "@/utils/debug";
import type { QueuedMessage } from "@/utils/message-queue-bridge";

/**
 * The TUI's authoritative queue. `queueDisplay` is derived UI state kept in
 * sync only through these callbacks: enqueue appends, dequeue/remove drop by
 * queue item id, clear empties, and pause/resume re-project the paused flags.
 *
 * maxItems: Infinity disables drop limits to match the earlier unbounded
 * array semantics.
 */
export function createTuiQueueRuntime(
  setQueueDisplay: Dispatch<SetStateAction<QueuedMessage[]>>,
): QueueRuntime {
  const queue: QueueRuntime = new QueueRuntime({
    maxItems: Infinity,
    callbacks: {
      onEnqueued: (item, queueLen) => {
        debugLog(
          "queue-lifecycle",
          `enqueued item_id=${item.id} kind=${item.kind} queue_len=${queueLen}`,
        );
        if (item.kind === "message" || item.kind === "task_notification") {
          setQueueDisplay((prev) => [...prev, toQueuedMsg(item)]);
        }
      },
      onDequeued: (batch) => {
        debugLog(
          "queue-lifecycle",
          `dequeued batch_id=${batch.batchId} merged_count=${batch.mergedCount} queue_len_after=${batch.queueLenAfter}`,
        );
        // Drop by id, not by head count: a dequeue may skip Esc-parked user
        // messages sitting ahead of the items it consumed.
        const consumed = new Set(batch.items.map((item) => item.id));
        setQueueDisplay((prev) =>
          prev.filter(
            (msg) =>
              msg.queueItemId === undefined || !consumed.has(msg.queueItemId),
          ),
        );
      },
      onBlocked: (reason, queueLen) =>
        debugLog(
          "queue-lifecycle",
          `blocked reason=${reason} queue_len=${queueLen}`,
        ),
      onCleared: (reason, clearedCount) => {
        debugLog(
          "queue-lifecycle",
          `cleared reason=${reason} cleared_count=${clearedCount}`,
        );
        setQueueDisplay([]);
      },
      onRemoved: (item, queueLen) => {
        debugLog(
          "queue-lifecycle",
          `removed item_id=${item.id} kind=${item.kind} queue_len=${queueLen}`,
        );
        setQueueDisplay((prev) =>
          prev.filter((msg) => msg.queueItemId !== item.id),
        );
      },
      onPauseChanged: (pausedCount, queueLen) => {
        debugLog(
          "queue-lifecycle",
          `pause changed paused=${pausedCount} queue_len=${queueLen}`,
        );
        const pausedIds = new Set(
          queue.items.filter((item) => item.paused).map((item) => item.id),
        );
        setQueueDisplay((prev) =>
          prev.map((msg) => {
            const paused =
              msg.queueItemId !== undefined && pausedIds.has(msg.queueItemId);
            if (paused === Boolean(msg.paused)) return msg;
            return paused
              ? { ...msg, paused: true }
              : { ...msg, paused: undefined };
          }),
        );
      },
    },
  });
  return queue;
}
