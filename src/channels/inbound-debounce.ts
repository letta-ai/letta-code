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
  debounceMs: number;
  buildKey: (item: T) => string | null | undefined;
  shouldDebounce?: (item: T) => boolean;
  onFlush: (items: T[]) => Promise<void>;
  onError?: (err: unknown, items: T[]) => void;
  maxTrackedKeys?: number;
}

export interface InboundDebouncer<T> {
  enqueue: (item: T) => Promise<void>;
  flushKey: (key: string) => Promise<void>;
  flushAll: () => Promise<void>;
  cancelAll: () => void;
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
      } catch {}
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

  const flushAllInternal = async (): Promise<void> => {
    await Promise.all(
      Array.from(buffers.entries()).map(([key, buffer]) =>
        flushBuffer(key, buffer),
      ),
    );
  };

  const cancelAllInternal = (): void => {
    for (const [key, buffer] of Array.from(buffers.entries())) {
      buffers.delete(key);
      if (buffer.timeout) {
        clearTimeout(buffer.timeout);
        buffer.timeout = null;
      }
      buffer.items = [];
      releaseBuffer(buffer);
      void buffer.task.catch(() => undefined);
    }
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
    flushAll: flushAllInternal,
    cancelAll: cancelAllInternal,
  };
}
