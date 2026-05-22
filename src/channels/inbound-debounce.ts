/**
 * Trailing-edge keyed debouncer for inbound channel messages.
 *
 * When a burst of messages arrives with the same key (e.g. a user sending
 * several short Slack messages in a row), they are buffered and flushed as
 * a single batch after `debounceMs` of quiet time. Ordering per key is
 * preserved: an immediate (non-debounced) item for the same key cannot
 * overtake a pending debounced flush.
 *
 * Ported (with minor simplifications) from openclaw's
 * `src/auto-reply/inbound-debounce.ts`, which has field-tested the
 * reserved-slot ordering model.
 */

const DEFAULT_MAX_TRACKED_KEYS = 2048;

type DebounceBuffer<T> = {
  items: T[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
  releaseReady: () => void;
  readyReleased: boolean;
  task: Promise<void>;
};

export interface InboundDebounceParams<T> {
  /** Debounce window in ms. `0` disables debouncing (items flush immediately). */
  debounceMs: number;
  /**
   * Group key for an item. Items with the same key stack together.
   * Returning `null`/`undefined` forces immediate dispatch (no grouping).
   */
  buildKey: (item: T) => string | null | undefined;
  /**
   * Optional per-item gate. Return `false` to bypass debouncing for the
   * item (flushes immediately, but still respects any pending buffer for
   * the same key to preserve ordering).
   */
  shouldDebounce?: (item: T) => boolean;
  /** Called with the buffered items when a key's window expires. */
  onFlush: (items: T[]) => Promise<void>;
  /** Called when `onFlush` throws. Non-throwing. */
  onError?: (err: unknown, items: T[]) => void;
  /** Safety cap on the number of tracked keys. Defaults to 2048. */
  maxTrackedKeys?: number;
}

export interface InboundDebouncer<T> {
  /**
   * Enqueue an item. Resolves when the flush that owns this item (if any)
   * has been dispatched via `onFlush`. For immediate (non-debounced) items,
   * resolves after dispatch.
   */
  enqueue: (item: T) => Promise<void>;
  /** Force an immediate flush for a specific key, if any buffer is pending. */
  flushKey: (key: string) => Promise<void>;
}

export function createInboundDebouncer<T>(
  params: InboundDebounceParams<T>,
): InboundDebouncer<T> {
  const buffers = new Map<string, DebounceBuffer<T>>();
  const keyChains = new Map<string, Promise<void>>();
  const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));
  const maxTrackedKeys = Math.max(
    1,
    Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS),
  );

  const runFlush = async (items: T[]): Promise<void> => {
    try {
      await params.onFlush(items);
    } catch (err) {
      try {
        params.onError?.(err, items);
      } catch {
        // Flush failures are surfaced via onError; swallow to keep chains
        // alive for future items with the same key.
      }
    }
  };

  const enqueueKeyTask = (
    key: string,
    task: () => Promise<void>,
  ): Promise<void> => {
    const previous = keyChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    const settled = next.catch(() => undefined);
    keyChains.set(key, settled);
    void settled.finally(() => {
      if (keyChains.get(key) === settled) {
        keyChains.delete(key);
      }
    });
    return next;
  };

  /**
   * Reserves a slot in the per-key task chain but blocks execution until
   * the caller explicitly calls `release()`. This lets us claim the
   * ordering slot for a buffered flush while still allowing later items
   * to queue up behind us without executing before we're ready.
   */
  const enqueueReservedKeyTask = (
    key: string,
    task: () => Promise<void>,
  ): { task: Promise<void>; release: () => void } => {
    let readyReleased = false;
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    return {
      task: enqueueKeyTask(key, async () => {
        await ready;
        await task();
      }),
      release: () => {
        if (readyReleased) return;
        readyReleased = true;
        releaseReady();
      },
    };
  };

  const releaseBuffer = (buffer: DebounceBuffer<T>): void => {
    if (buffer.readyReleased) return;
    buffer.readyReleased = true;
    buffer.releaseReady();
  };

  const flushBuffer = async (
    key: string,
    buffer: DebounceBuffer<T>,
  ): Promise<void> => {
    if (buffers.get(key) === buffer) {
      buffers.delete(key);
    }
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
      buffer.timeout = null;
    }
    releaseBuffer(buffer);
    await buffer.task;
  };

  const flushKeyInternal = async (key: string): Promise<void> => {
    const buffer = buffers.get(key);
    if (!buffer) return;
    await flushBuffer(key, buffer);
  };

  const scheduleFlush = (key: string, buffer: DebounceBuffer<T>): void => {
    if (buffer.timeout) {
      clearTimeout(buffer.timeout);
    }
    buffer.timeout = setTimeout(async () => {
      await flushBuffer(key, buffer);
    }, buffer.debounceMs);
    buffer.timeout.unref?.();
  };

  const canTrackKey = (key: string): boolean => {
    if (buffers.has(key) || keyChains.has(key)) return true;
    return (
      new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys
    );
  };

  const enqueue = async (item: T): Promise<void> => {
    const key = params.buildKey(item);
    const canDebounce =
      defaultDebounceMs > 0 && (params.shouldDebounce?.(item) ?? true);

    if (!canDebounce || !key) {
      if (!key) {
        await runFlush([item]);
        return;
      }

      // Reserve the keyed immediate slot before forcing the pending buffer
      // to flush so a fire-and-forget caller cannot be overtaken.
      if (buffers.has(key)) {
        const reservedTask = enqueueReservedKeyTask(key, async () => {
          await runFlush([item]);
        });
        try {
          await flushKeyInternal(key);
        } finally {
          reservedTask.release();
        }
        await reservedTask.task;
        return;
      }
      if (keyChains.has(key)) {
        await enqueueKeyTask(key, async () => {
          await runFlush([item]);
        });
        return;
      }
      await runFlush([item]);
      return;
    }

    const existing = buffers.get(key);
    if (existing) {
      existing.items.push(item);
      existing.debounceMs = defaultDebounceMs;
      scheduleFlush(key, existing);
      return;
    }

    if (!canTrackKey(key)) {
      // Map saturated: fall back to immediate keyed work to preserve
      // ordering but avoid unbounded buffer growth.
      await enqueueKeyTask(key, async () => {
        await runFlush([item]);
      });
      return;
    }

    let buffer!: DebounceBuffer<T>;
    const reservedTask = enqueueReservedKeyTask(key, async () => {
      if (buffer.items.length === 0) return;
      await runFlush(buffer.items);
    });
    buffer = {
      items: [item],
      timeout: null,
      debounceMs: defaultDebounceMs,
      releaseReady: reservedTask.release,
      readyReleased: false,
      task: reservedTask.task,
    };
    buffers.set(key, buffer);
    scheduleFlush(key, buffer);
  };

  return {
    enqueue,
    flushKey: flushKeyInternal,
  };
}
