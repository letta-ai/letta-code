import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  QueueBlockedReason,
  QueueClearedReason,
  QueueItemDroppedReason,
  QueueItemKind,
  QueueItemSource,
} from "../types/protocol";

export type { QueueBlockedReason, QueueClearedReason, QueueItemKind };

// ── Item types ───────────────────────────────────────────────────

type QueueItemBase = {
  /** Stable monotonic ID assigned on enqueue. */
  id: string;
  /** Optional client-side message correlation ID from submit payloads. */
  clientMessageId?: string;
  source: QueueItemSource;
  enqueuedAt: number;
};

export type MessageQueueItem = QueueItemBase & {
  kind: "message";
  /** Full multimodal content — string or content-part array. */
  content: MessageCreate["content"];
};

export type TaskNotificationQueueItem = QueueItemBase & {
  kind: "task_notification";
  /** XML notification string. */
  text: string;
};

export type ApprovalResultQueueItem = QueueItemBase & {
  kind: "approval_result";
  text: string;
};

export type OverlayActionQueueItem = QueueItemBase & {
  kind: "overlay_action";
  text: string;
};

export type QueueItem =
  | MessageQueueItem
  | TaskNotificationQueueItem
  | ApprovalResultQueueItem
  | OverlayActionQueueItem;

// ── Coalescability ───────────────────────────────────────────────

/** Coalescable items can be merged into a single submission batch. */
export function isCoalescable(kind: QueueItemKind): boolean {
  return kind === "message" || kind === "task_notification";
}

// ── Batch / callbacks ────────────────────────────────────────────

export interface DequeuedBatch {
  batchId: string;
  items: QueueItem[];
  /**
   * Number of items that were merged into this batch.
   * Equal to items.length for coalescable batches; 1 for barrier items.
   */
  mergedCount: number;
  /** Queue length after this batch was removed. */
  queueLenAfter: number;
}

export interface QueueCallbacks {
  onEnqueued?: (item: QueueItem, queueLen: number) => void;
  onDequeued?: (batch: DequeuedBatch) => void;
  /**
   * Fired on blocked-reason state transitions (not on every check).
   * Only fires when queue is non-empty.
   */
  onBlocked?: (reason: QueueBlockedReason, queueLen: number) => void;
  onCleared?: (reason: QueueClearedReason, clearedCount: number) => void;
  /**
   * Fired when an item is dropped.
   * queueLen is the post-operation queue depth:
   * - Soft-limit coalescable drop: one removed, one added → net unchanged.
   * - Hard-ceiling rejection: item not added → current length unchanged.
   */
  onDropped?: (
    item: QueueItem,
    reason: QueueItemDroppedReason,
    queueLen: number,
  ) => void;
}

// ── Options ──────────────────────────────────────────────────────

export interface QueueRuntimeOptions {
  /**
   * Soft limit. When reached, the oldest coalescable item is dropped
   * to make room for a new one. Default: 100.
   */
  maxItems?: number;
  /**
   * Hard ceiling. When reached, enqueue is rejected entirely (returns null)
   * for all item kinds and onDropped fires. Default: maxItems * 3.
   */
  hardMaxItems?: number;
  callbacks?: QueueCallbacks;
}

// ── Runtime ──────────────────────────────────────────────────────

export class QueueRuntime {
  private readonly store: QueueItem[] = [];
  private readonly callbacks: QueueCallbacks;
  private readonly maxItems: number;
  private readonly hardMaxItems: number;
  private nextId = 0;
  private nextBatchId = 0;

  // Blocked-reason transition tracking
  private lastEmittedBlockedReason: QueueBlockedReason | null = null;
  private blockedEmittedForNonEmpty = false;

  constructor(options: QueueRuntimeOptions = {}) {
    const maxItems = Math.max(1, Math.floor(options.maxItems ?? 100) || 100);
    const hardMaxItems = Math.max(
      maxItems,
      Math.floor(options.hardMaxItems ?? maxItems * 3) || maxItems * 3,
    );
    this.maxItems = maxItems;
    this.hardMaxItems = hardMaxItems;
    this.callbacks = options.callbacks ?? {};
  }

  // ── Enqueue ────────────────────────────────────────────────────

  /**
   * Add an item to the queue. Returns the enqueued item (with assigned id
   * and enqueuedAt), or null if the hard ceiling was reached.
   *
   * - If at soft limit and item is coalescable: drops oldest coalescable item.
   * - If at soft limit and item is a barrier: allows overflow (soft limit only
   *   applies to coalescable items).
   * - If at hard ceiling: rejects all item kinds, fires onDropped("buffer_limit").
   */
  enqueue(input: Omit<QueueItem, "id" | "enqueuedAt">): QueueItem | null {
    // Hard ceiling check
    if (this.store.length >= this.hardMaxItems) {
      const phantom = this.makeItem(input);
      this.safeCallback(
        "onDropped",
        phantom,
        "buffer_limit",
        this.store.length,
      );
      return null;
    }

    // Soft limit: only drop coalescable items
    if (this.store.length >= this.maxItems && isCoalescable(input.kind)) {
      const dropIdx = this.store.findIndex((i) => isCoalescable(i.kind));
      const dropped =
        dropIdx !== -1 ? this.store.splice(dropIdx, 1)[0] : undefined;
      if (dropped !== undefined) {
        const item = this.makeItem(input);
        this.store.push(item);
        // queueLen after: same as before (one dropped, one added)
        this.safeCallback(
          "onDropped",
          dropped,
          "buffer_limit",
          this.store.length,
        );
        this.safeCallback("onEnqueued", item, this.store.length);
        return item;
      }
    }

    const item = this.makeItem(input);
    this.store.push(item);
    this.safeCallback("onEnqueued", item, this.store.length);

    // If queue just became non-empty while blocked, blocked-epoch tracking resets
    // so the next tryDequeue call can re-emit the blocked event.
    if (this.store.length === 1) {
      this.blockedEmittedForNonEmpty = false;
    }

    return item;
  }

  // ── Dequeue ────────────────────────────────────────────────────

  /**
   * Attempt to dequeue the next batch.
   *
   * Pass `blockedReason` (non-null) when the caller's gating conditions
   * prevent submission. Pass `null` when submission is allowed.
   *
   * Returns null if blocked or queue is empty.
   * Returns a DequeuedBatch with coalescable items (or a single barrier).
   */
  tryDequeue(blockedReason: QueueBlockedReason | null): DequeuedBatch | null {
    if (blockedReason !== null) {
      // Only emit on transition when queue is non-empty
      if (this.store.length > 0) {
        const shouldEmit =
          blockedReason !== this.lastEmittedBlockedReason ||
          !this.blockedEmittedForNonEmpty;
        if (shouldEmit) {
          this.lastEmittedBlockedReason = blockedReason;
          this.blockedEmittedForNonEmpty = true;
          this.safeCallback("onBlocked", blockedReason, this.store.length);
        }
      }
      return null;
    }

    // Unblocked — reset tracking
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;

    if (this.store.length === 0) {
      return null;
    }

    // Drain contiguous coalescable items from head
    const batch: QueueItem[] = [];
    while (
      this.store.length > 0 &&
      isCoalescable(this.store[0]?.kind ?? "approval_result")
    ) {
      const item = this.store.shift();
      if (item) batch.push(item);
    }

    // If head was a barrier (no coalescables found), dequeue it alone
    if (batch.length === 0 && this.store.length > 0) {
      const item = this.store.shift();
      if (item) batch.push(item);
    }

    if (batch.length === 0) {
      return null;
    }

    // When queue becomes empty after dequeue, reset blocked epoch tracking
    if (this.store.length === 0) {
      this.blockedEmittedForNonEmpty = false;
    }

    const result: DequeuedBatch = {
      batchId: `batch-${++this.nextBatchId}`,
      items: batch,
      mergedCount: batch.length,
      queueLenAfter: this.store.length,
    };

    this.safeCallback("onDequeued", result);
    return result;
  }

  /**
   * Caller-controlled dequeue: removes exactly the first `n` items (or all
   * available if fewer exist) without applying the coalescable/barrier policy.
   * Used when the caller has already decided how many items to consume (e.g.
   * headless coalescing loop, listen one-message-per-turn).
   * Returns null if queue is empty or n <= 0.
   */
  consumeItems(n: number): DequeuedBatch | null {
    if (this.store.length === 0 || n <= 0) return null;
    const count = Math.min(n, this.store.length);
    const batch = this.store.splice(0, count);
    if (this.store.length === 0) {
      this.blockedEmittedForNonEmpty = false;
    }
    const result: DequeuedBatch = {
      batchId: `batch-${++this.nextBatchId}`,
      items: batch,
      mergedCount: count,
      queueLenAfter: this.store.length,
    };
    this.safeCallback("onDequeued", result);
    return result;
  }

  /**
   * Reset blocked-reason tracking after a turn completes (unblocked transition).
   * Call when the consumer becomes idle so the next arrival can re-emit
   * onBlocked correctly. Should only be called when the queue is actually
   * idle (i.e. pendingTurns === 0 in listen, turnInProgress === false in headless).
   */
  resetBlockedState(): void {
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;
  }

  // ── Clear ──────────────────────────────────────────────────────

  /** Remove all items and fire onCleared. */
  clear(reason: QueueClearedReason): void {
    const count = this.store.length;
    this.store.length = 0;
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;
    this.safeCallback("onCleared", reason, count);
  }

  // ── Accessors ──────────────────────────────────────────────────

  get length(): number {
    return this.store.length;
  }

  get isEmpty(): boolean {
    return this.store.length === 0;
  }

  get items(): readonly QueueItem[] {
    return this.store.slice();
  }

  peek(): readonly QueueItem[] {
    return this.store.slice();
  }

  // ── Internals ──────────────────────────────────────────────────

  private makeItem(input: Omit<QueueItem, "id" | "enqueuedAt">): QueueItem {
    return {
      ...input,
      id: `q-${++this.nextId}`,
      enqueuedAt: Date.now(),
    } as QueueItem;
  }

  private safeCallback<K extends keyof QueueCallbacks>(
    name: K,
    ...args: Parameters<NonNullable<QueueCallbacks[K]>>
  ): void {
    try {
      (this.callbacks[name] as ((...a: unknown[]) => void) | undefined)?.(
        ...args,
      );
    } catch (err) {
      if (process.env.DEBUG) {
        console.error(`[QueueRuntime] callback "${name}" threw:`, err);
      }
    }
  }
}
