import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  QueueBlockedReason,
  QueueClearedReason,
  QueueItemDroppedReason,
  QueueItemKind,
  QueueItemSource,
} from "@/types/protocol";
import { isDebugEnabled } from "@/utils/debug";

export type { QueueBlockedReason, QueueClearedReason, QueueItemKind };

// ── Item types ───────────────────────────────────────────────────

type QueueItemBase = {
  /** Stable monotonic ID assigned on enqueue. */
  id: string;
  /** Optional client-side message correlation ID from submit payloads. */
  clientMessageId?: string;
  /** Optional agent scope for listener-mode attribution. */
  agentId?: string;
  /** Optional conversation scope for listener-mode attribution. */
  conversationId?: string;
  /**
   * Cloud user id of the human who actually submitted this item,
   * forwarded from cloud-api on the inbound `input` frame. The
   * listener echoes this on the outbound createMessage HTTP call
   * (X-Letta-Acting-User-Id header) so cloud attributes credits +
   * rate limits to the actual sender — not the user whose API key
   * spawned the sandbox / desktop runtime.
   *
   * Undefined for self-hosted, single-user, or pre-channel-split
   * flows where cloud doesn't stamp the field.
   */
  actingUserId?: string;
  source: QueueItemSource;
  enqueuedAt: number;
  /**
   * Parked by a user interrupt. Paused items stay visible in the queue but
   * are skipped by every dequeue path until `resume()` clears the flag.
   * Only user-authored messages are ever paused; system-originated items
   * (task notifications, cron prompts, mod continuations) keep flowing.
   */
  paused?: boolean;
};

export type MessageQueueItem = QueueItemBase & {
  kind: "message";
  /** Full multimodal content — string or content-part array. */
  content: MessageCreate["content"];
  /**
   * Never merge this item with other queued messages. Set by request-scoped
   * producers (e.g. the OpenAI-compat HTTP bridge) where each message must
   * run as its own turn so its correlated client request can settle.
   */
  noCoalesce?: boolean;
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

export type CronPromptQueueItem = QueueItemBase & {
  kind: "cron_prompt";
  /** XML-wrapped prompt text. */
  text: string;
  /** Cron task ID for tracing. */
  cronTaskId: string;
};

export type ModContinueQueueItem = QueueItemBase & {
  kind: "mod_continue";
  /** Follow-up text from a mod's turn_end { continue }, sent as a user message. */
  text: string;
};

export type QueueItem =
  | MessageQueueItem
  | TaskNotificationQueueItem
  | CronPromptQueueItem
  | ApprovalResultQueueItem
  | OverlayActionQueueItem
  | ModContinueQueueItem;

// ── Coalescability ───────────────────────────────────────────────

/** Coalescable items can be merged into a single submission batch. */
export function isCoalescable(kind: QueueItemKind): boolean {
  return (
    kind === "message" ||
    kind === "task_notification" ||
    kind === "cron_prompt" ||
    kind === "mod_continue"
  );
}

function hasSameScope(a: QueueItem, b: QueueItem): boolean {
  return (
    (a.agentId ?? null) === (b.agentId ?? null) &&
    (a.conversationId ?? null) === (b.conversationId ?? null)
  );
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
  onCleared?: (
    reason: QueueClearedReason,
    clearedCount: number,
    items: QueueItem[],
  ) => void;
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
  /**
   * Fired when an item is explicitly removed via removeItem().
   * queueLen is the post-removal queue depth.
   */
  onRemoved?: (item: QueueItem, queueLen: number) => void;
  /**
   * Fired when pause()/resume() changes which items are parked.
   * pausedCount is the number of items still paused afterwards.
   */
  onPauseChanged?: (pausedCount: number, queueLen: number) => void;
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

    if (this.store.length > 0 && this.readyLength === 0) {
      // Only parked user messages remain: report that as the blocked reason
      // (transition-deduplicated like every other reason) and dequeue nothing.
      return this.tryDequeue("paused_by_user");
    }

    // Unblocked — reset tracking
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;

    if (this.store.length === 0) {
      return null;
    }

    // Drain coalescable ready items from the first ready item onward. Paused
    // items are skipped, never consumed; a ready barrier ends the batch.
    const batch: QueueItem[] = [];
    const first = this.store.find((item) => !item.paused);
    if (first && isCoalescable(first.kind)) {
      for (const item of this.store) {
        if (item.paused) continue;
        if (!isCoalescable(item.kind) || !hasSameScope(first, item)) break;
        batch.push(item);
      }
    } else if (first) {
      // First ready item is a barrier: dequeue it alone
      batch.push(first);
    }

    if (batch.length === 0) {
      return null;
    }
    this.removeAll(batch);

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
    // Paused items are skipped: the first `n` ready items are consumed.
    const batch = this.store.filter((item) => !item.paused).slice(0, n);
    const count = batch.length;
    if (count === 0) return null;
    this.removeAll(batch);
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

  // ── Remove ──────────────────────────────────────────────────────

  /**
   * Remove a specific item by ID. Returns the removed item, or null
   * if no item with that ID exists. Fires onRemoved callback.
   */
  removeItem(id: string): QueueItem | null {
    const idx = this.store.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    const removed = this.store.splice(idx, 1)[0];
    if (!removed) return null;
    if (this.store.length === 0) {
      this.blockedEmittedForNonEmpty = false;
    }
    this.safeCallback("onRemoved", removed, this.store.length);
    return removed;
  }

  // ── Pause / resume ─────────────────────────────────────────────

  /**
   * Park every queued user message. Called when the user interrupts: the
   * interrupted turn stops, and the messages the user queued behind it wait
   * for an explicit resume or for the user's next message instead of
   * starting the next turn on their own. System-originated items are not
   * affected. Returns the number of items newly paused.
   */
  pause(): number {
    let changed = 0;
    for (const item of this.store) {
      if (item.kind === "message" && item.source === "user" && !item.paused) {
        item.paused = true;
        changed += 1;
      }
    }
    if (changed > 0) {
      this.blockedEmittedForNonEmpty = false;
      this.safeCallback("onPauseChanged", this.pausedCount, this.store.length);
    }
    return changed;
  }

  /** Release every paused item. Returns the number of items resumed. */
  resume(): number {
    let changed = 0;
    for (const item of this.store) {
      if (item.paused) {
        delete item.paused;
        changed += 1;
      }
    }
    if (changed > 0) {
      this.lastEmittedBlockedReason = null;
      this.blockedEmittedForNonEmpty = false;
      this.safeCallback("onPauseChanged", 0, this.store.length);
    }
    return changed;
  }

  // ── Clear ──────────────────────────────────────────────────────

  /** Remove all items and fire onCleared. */
  clear(reason: QueueClearedReason): void {
    const count = this.store.length;
    const clearedItems = this.store.slice();
    this.store.length = 0;
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;
    this.safeCallback("onCleared", reason, count, clearedItems);
  }

  // ── Accessors ──────────────────────────────────────────────────

  get length(): number {
    return this.store.length;
  }

  get isEmpty(): boolean {
    return this.store.length === 0;
  }

  /** Items a dequeue may take right now (everything that is not paused). */
  get readyLength(): number {
    return this.store.reduce((n, item) => (item.paused ? n : n + 1), 0);
  }

  get pausedCount(): number {
    return this.store.length - this.readyLength;
  }

  get items(): readonly QueueItem[] {
    return this.store.slice();
  }

  peek(): readonly QueueItem[] {
    return this.store.slice();
  }

  /** Like peek(), without paused items. Dequeue planners must use this. */
  peekReady(): readonly QueueItem[] {
    return this.store.filter((item) => !item.paused);
  }

  // ── Internals ──────────────────────────────────────────────────

  /** Remove the given items (by identity) from the store, preserving order. */
  private removeAll(items: readonly QueueItem[]): void {
    const removing = new Set(items);
    let write = 0;
    for (const item of this.store) {
      if (!removing.has(item)) this.store[write++] = item;
    }
    this.store.length = write;
  }

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
      if (isDebugEnabled()) {
        console.error(`[QueueRuntime] callback "${name}" threw:`, err);
      }
    }
  }
}
