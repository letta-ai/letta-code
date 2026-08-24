export type DiscordObserverBatchTimerHandle = ReturnType<typeof setInterval>;

export interface DiscordObserverBatchTimers {
  setInterval(
    callback: () => void,
    intervalMs: number,
  ): DiscordObserverBatchTimerHandle;
  clearInterval(handle: DiscordObserverBatchTimerHandle): void;
}

export interface DiscordObserverBatchMessage {
  /** Milliseconds since the Unix epoch. */
  timestamp: number;
  /** Text counted toward the batch character limit. */
  text: string;
}

export type DiscordObserverBatchStopDisposition = "flush" | "cancel";

export interface DiscordObserverBatcherOptions<
  Message extends DiscordObserverBatchMessage,
> {
  flushIntervalMs: number;
  maxMessages: number;
  maxCharacters: number;
  /**
   * Receives one account-wide batch. Fan-out to observer destinations belongs in
   * this callback so messages are collected and removed only once.
   */
  onBatch(batch: readonly Message[]): void | Promise<void>;
  /** Overrides text measurement when rendered text differs from `message.text`. */
  measureCharacters?: (message: Message) => number;
  /** Receives failures from timer-initiated deliveries. */
  onBackgroundError?: (error: unknown) => void;
  timers?: DiscordObserverBatchTimers;
}

export interface DiscordObserverBatcher<Message> {
  /**
   * Adds a message to the current account-wide window. The returned promise
   * settles after delivery only when this message triggers an early flush.
   */
  add(message: Message): Promise<void>;
  /** Closes and delivers the current window, if it is non-empty. */
  flush(): Promise<void>;
  /**
   * Stops the periodic timer and waits for all selected batches to finish.
   * `cancel` drops only the still-open window; already selected batches finish.
   */
  stop(disposition?: DiscordObserverBatchStopDisposition): Promise<void>;
  readonly pendingMessages: number;
  readonly pendingCharacters: number;
  readonly stopped: boolean;
}

type QueuedMessage<Message> = {
  message: Message;
  sequence: number;
};

const SYSTEM_DISCORD_OBSERVER_BATCH_TIMERS: DiscordObserverBatchTimers = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

/**
 * Creates a tumbling-window collector for all observed messages on one Discord
 * account. Batches are delivered in timestamp order and deliveries never
 * overlap, even when a timer and a size trigger fire concurrently.
 */
export function createDiscordObserverBatcher<
  Message extends DiscordObserverBatchMessage,
>(
  options: DiscordObserverBatcherOptions<Message>,
): DiscordObserverBatcher<Message> {
  requirePositiveInteger("flushIntervalMs", options.flushIntervalMs);
  requirePositiveInteger("maxMessages", options.maxMessages);
  requirePositiveInteger("maxCharacters", options.maxCharacters);

  const timers = options.timers ?? SYSTEM_DISCORD_OBSERVER_BATCH_TIMERS;
  const measureCharacters =
    options.measureCharacters ?? ((message: Message) => message.text.length);
  let window: QueuedMessage<Message>[] = [];
  let windowCharacters = 0;
  let nextSequence = 0;
  let isStopped = false;
  let deliveryTail: Promise<void> = Promise.resolve();

  function selectWindow(): readonly Message[] | null {
    if (window.length === 0) return null;

    const selected = window;
    window = [];
    windowCharacters = 0;
    selected.sort(
      (left, right) =>
        left.message.timestamp - right.message.timestamp ||
        left.sequence - right.sequence,
    );
    return selected.map((entry) => entry.message);
  }

  function enqueueSelected(batch: readonly Message[]): Promise<void> {
    const delivery = deliveryTail.then(() => options.onBatch(batch));
    // Keep the serialization chain usable after a failed callback. The caller
    // that selected this batch still receives the original rejection.
    deliveryTail = delivery.catch(() => undefined);
    return delivery;
  }

  function flushWindow(): Promise<void> {
    const batch = selectWindow();
    return batch ? enqueueSelected(batch) : deliveryTail;
  }

  function reportBackgroundError(error: unknown): void {
    try {
      options.onBackgroundError?.(error);
    } catch {
      // A diagnostic hook must not create an unhandled timer rejection.
    }
  }

  const timer = timers.setInterval(() => {
    void flushWindow().catch(reportBackgroundError);
  }, options.flushIntervalMs);
  timer.unref?.();

  return {
    add(message): Promise<void> {
      if (isStopped) {
        return Promise.reject(new Error("Discord observer batcher is stopped"));
      }
      const measured = measureCharacters(message);
      if (!Number.isFinite(measured) || measured < 0) {
        return Promise.reject(
          new RangeError("measureCharacters must return a non-negative number"),
        );
      }
      const characters = Math.ceil(measured);
      window.push({ message, sequence: nextSequence++ });
      windowCharacters += characters;

      if (
        window.length >= options.maxMessages ||
        windowCharacters >= options.maxCharacters
      ) {
        return flushWindow();
      }
      return Promise.resolve();
    },

    flush(): Promise<void> {
      return flushWindow();
    },

    async stop(
      disposition: DiscordObserverBatchStopDisposition = "flush",
    ): Promise<void> {
      if (!isStopped) {
        isStopped = true;
        timers.clearInterval(timer);
        if (disposition === "cancel") {
          window = [];
          windowCharacters = 0;
        } else {
          await flushWindow();
        }
      }
      await deliveryTail;
    },

    get pendingMessages(): number {
      return window.length;
    },

    get pendingCharacters(): number {
      return windowCharacters;
    },

    get stopped(): boolean {
      return isStopped;
    },
  };
}
