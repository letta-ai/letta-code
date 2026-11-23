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

type QueueItemBase = {
  id: string;
  clientMessageId?: string;
  agentId?: string;
  conversationId?: string;
  actingUserId?: string | null;
  source: QueueItemSource;
  enqueuedAt: number;
  paused?: boolean;
};

export type MessageQueueItem = QueueItemBase & {
  kind: "message";
  content: MessageCreate["content"];
  noCoalesce?: boolean;
};

export type TaskNotificationQueueItem = QueueItemBase & {
  kind: "task_notification";
  text: string;
  content?: MessageCreate["content"];
  clientMessageIds?: string[];
};

export type CronPromptQueueItem = QueueItemBase & {
  kind: "cron_prompt";
  text: string;
  cronTaskId: string;
};

export type ModContinueQueueItem = QueueItemBase & {
  kind: "mod_continue";
  text: string;
};

export type QueueItem =
  | MessageQueueItem
  | TaskNotificationQueueItem
  | CronPromptQueueItem
  | ModContinueQueueItem;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type QueueItemInput = DistributiveOmit<QueueItem, "id" | "enqueuedAt">;

function hasSameScope(a: QueueItem, b: QueueItem): boolean {
  return (
    (a.agentId ?? null) === (b.agentId ?? null) &&
    (a.conversationId ?? null) === (b.conversationId ?? null)
  );
}

export interface DequeuedBatch {
  batchId: string;
  items: QueueItem[];
  mergedCount: number;
  queueLenAfter: number;
}

export interface QueueCallbacks {
  beforeDequeued?: (items: readonly QueueItem[]) => boolean;
  beforeDropped?: (item: QueueItem) => boolean;
  beforeRemoved?: (item: QueueItem) => boolean;
  beforeCleared?: (
    reason: QueueClearedReason,
    items: readonly QueueItem[],
  ) => boolean;
  onEnqueued?: (item: QueueItem, queueLen: number) => void;
  onDequeued?: (batch: DequeuedBatch) => void;
  onBlocked?: (reason: QueueBlockedReason, queueLen: number) => void;
  onCleared?: (
    reason: QueueClearedReason,
    clearedCount: number,
    items: QueueItem[],
  ) => void;
  onDropped?: (
    item: QueueItem,
    reason: QueueItemDroppedReason,
    queueLen: number,
  ) => void;
  onRemoved?: (item: QueueItem, queueLen: number) => void;
  onPauseChanged?: (pausedCount: number, queueLen: number) => void;
}

export interface QueueRuntimeOptions {
  maxItems?: number;
  hardMaxItems?: number;
  callbacks?: QueueCallbacks;
}

export class QueueRuntime {
  private readonly store: QueueItem[] = [];
  private readonly callbacks: QueueCallbacks;
  private readonly maxItems: number;
  private readonly hardMaxItems: number;
  private nextId = 0;
  private nextBatchId = 0;

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

  enqueue(
    input: QueueItemInput,
    options: { preserveExisting?: boolean } = {},
  ): QueueItem | null {
    if (
      options.preserveExisting &&
      (this.store.length >= this.hardMaxItems ||
        this.store.length >= this.maxItems)
    ) {
      return null;
    }
    if (this.store.length >= this.hardMaxItems) {
      const phantom = this.makeItem(input);
      if (!this.mutationAllowed("beforeDropped", phantom)) return null;
      this.safeCallback(
        "onDropped",
        phantom,
        "buffer_limit",
        this.store.length,
      );
      return null;
    }

    if (this.store.length >= this.maxItems) {
      const dropped = this.store[0];
      if (dropped !== undefined) {
        if (!this.mutationAllowed("beforeDropped", dropped)) {
          const rejected = this.makeItem(input);
          if (!this.mutationAllowed("beforeDropped", rejected)) return null;
          this.safeCallback(
            "onDropped",
            rejected,
            "buffer_limit",
            this.store.length,
          );
          return null;
        }
        this.store.shift();
        const item = this.makeItem(input);
        this.store.push(item);
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

    if (this.store.length === 1) {
      this.blockedEmittedForNonEmpty = false;
    }

    return item;
  }

  tryDequeue(blockedReason: QueueBlockedReason | null): DequeuedBatch | null {
    if (blockedReason !== null) {
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
      return this.tryDequeue("paused_by_user");
    }

    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;

    if (this.store.length === 0) {
      return null;
    }

    const batch: QueueItem[] = [];
    const first = this.store.find((item) => !item.paused);
    if (first) {
      for (const item of this.store) {
        if (item.paused) continue;
        if (!hasSameScope(first, item)) break;
        batch.push(item);
      }
    }

    if (batch.length === 0) {
      return null;
    }
    if (!this.mutationAllowed("beforeDequeued", batch)) return null;
    this.removeAll(batch);

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

  consumeItems(n: number): DequeuedBatch | null {
    if (this.store.length === 0 || n <= 0) return null;
    const batch = this.store.filter((item) => !item.paused).slice(0, n);
    const count = batch.length;
    if (count === 0) return null;
    if (!this.mutationAllowed("beforeDequeued", batch)) return null;
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

  resetBlockedState(): void {
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;
  }

  removeItem(id: string): QueueItem | null {
    const idx = this.store.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    const candidate = this.store[idx];
    if (!candidate || !this.mutationAllowed("beforeRemoved", candidate)) {
      return null;
    }
    const removed = this.store.splice(idx, 1)[0];
    if (!removed) return null;
    if (this.store.length === 0) {
      this.blockedEmittedForNonEmpty = false;
    }
    this.safeCallback("onRemoved", removed, this.store.length);
    return removed;
  }

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

  clear(reason: QueueClearedReason): void {
    const count = this.store.length;
    const clearedItems = this.store.slice();
    if (!this.mutationAllowed("beforeCleared", reason, clearedItems)) return;
    this.store.length = 0;
    this.lastEmittedBlockedReason = null;
    this.blockedEmittedForNonEmpty = false;
    this.safeCallback("onCleared", reason, count, clearedItems);
  }

  get length(): number {
    return this.store.length;
  }

  get isEmpty(): boolean {
    return this.store.length === 0;
  }

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

  peekReady(): readonly QueueItem[] {
    return this.store.filter((item) => !item.paused);
  }

  private removeAll(items: readonly QueueItem[]): void {
    const removing = new Set(items);
    let write = 0;
    for (const item of this.store) {
      if (!removing.has(item)) this.store[write++] = item;
    }
    this.store.length = write;
  }

  private makeItem(input: QueueItemInput): QueueItem {
    return {
      ...input,
      id: `q-${++this.nextId}`,
      enqueuedAt: Date.now(),
    } as QueueItem;
  }

  private mutationAllowed<
    K extends keyof Pick<
      QueueCallbacks,
      "beforeDequeued" | "beforeDropped" | "beforeRemoved" | "beforeCleared"
    >,
  >(name: K, ...args: Parameters<NonNullable<QueueCallbacks[K]>>): boolean {
    const callback = this.callbacks[name] as
      | ((...values: Parameters<NonNullable<QueueCallbacks[K]>>) => boolean)
      | undefined;
    return callback?.(...args) ?? true;
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
