import { expect, mock, test } from "bun:test";
import {
  createDiscordObserverBatcher,
  type DiscordObserverBatchTimerHandle,
  type DiscordObserverBatchTimers,
} from "./observer-batcher";

type Message = {
  id: string;
  timestamp: number;
  text: string;
  channelId: string;
};

type RecordedInterval = {
  callback: () => void;
  intervalMs: number;
  handle: DiscordObserverBatchTimerHandle;
};

function createRecordedTimers() {
  let nextId = 0;
  const intervals: RecordedInterval[] = [];
  const cleared = new Set<DiscordObserverBatchTimerHandle>();
  const timers: DiscordObserverBatchTimers = {
    setInterval: (callback, intervalMs) => {
      const handle = {
        id: ++nextId,
        unref: mock(() => undefined),
      } as unknown as DiscordObserverBatchTimerHandle;
      intervals.push({ callback, intervalMs, handle });
      return handle;
    },
    clearInterval: (handle) => {
      cleared.add(handle);
    },
  };
  return { timers, intervals, cleared };
}

function message(
  id: string,
  timestamp: number,
  text = id,
  channelId = "channel-1",
): Message {
  return { id, timestamp, text, channelId };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("periodically flushes one account-wide batch in chronological order", async () => {
  const recorded = createRecordedTimers();
  const batches: (readonly Message[])[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 600_000,
    maxMessages: 100,
    maxCharacters: 10_000,
    timers: recorded.timers,
    onBatch: (batch) => {
      batches.push(batch);
    },
  });

  await batcher.add(message("later", 30, "later", "channel-2"));
  await batcher.add(message("first", 10, "first", "channel-1"));
  await batcher.add(message("same-a", 20, "same-a", "channel-3"));
  await batcher.add(message("same-b", 20, "same-b", "channel-1"));

  expect(recorded.intervals).toHaveLength(1);
  expect(recorded.intervals[0]?.intervalMs).toBe(600_000);
  recorded.intervals[0]?.callback();
  await batcher.flush();

  expect(batches).toHaveLength(1);
  expect(batches[0]?.map((entry) => entry.id)).toEqual([
    "first",
    "same-a",
    "same-b",
    "later",
  ]);
  expect(batcher.pendingMessages).toBe(0);
  expect(batcher.pendingCharacters).toBe(0);
  await batcher.stop("cancel");
});

test("flushes early at the message-count limit without duplicate delivery", async () => {
  const recorded = createRecordedTimers();
  const delivered: string[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 2,
    maxCharacters: 100,
    timers: recorded.timers,
    onBatch: (batch) => {
      delivered.push(...batch.map((entry) => entry.id));
    },
  });

  await batcher.add(message("one", 1));
  await batcher.add(message("two", 2));
  recorded.intervals[0]?.callback();
  recorded.intervals[0]?.callback();
  await batcher.flush();

  expect(delivered).toEqual(["one", "two"]);
  await batcher.stop("cancel");
});

test("flushes early at the measured character limit", async () => {
  const recorded = createRecordedTimers();
  const batches: string[][] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 10,
    maxCharacters: 5,
    timers: recorded.timers,
    measureCharacters: (entry) => entry.text.length + 1,
    onBatch: (batch) => {
      batches.push(batch.map((entry) => entry.id));
    },
  });

  await batcher.add(message("one", 1, "ab"));
  expect(batcher.pendingCharacters).toBe(3);
  await batcher.add(message("two", 2, "c"));

  expect(batches).toEqual([["one", "two"]]);
  await batcher.stop("cancel");
});

test("serializes batches selected while an earlier delivery is in flight", async () => {
  const recorded = createRecordedTimers();
  const firstDelivery = deferred();
  const started: string[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 1,
    maxCharacters: 100,
    timers: recorded.timers,
    onBatch: async (batch) => {
      const id = batch[0]?.id;
      if (id) started.push(id);
      if (id === "one") await firstDelivery.promise;
    },
  });

  const first = batcher.add(message("one", 1));
  const second = batcher.add(message("two", 2));
  await Promise.resolve();
  expect(started).toEqual(["one"]);

  firstDelivery.resolve();
  await Promise.all([first, second]);
  expect(started).toEqual(["one", "two"]);
  await batcher.stop("cancel");
});

test("stop flush delivers the open window and waits for delivery", async () => {
  const recorded = createRecordedTimers();
  const delivery = deferred();
  const delivered: string[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 10,
    maxCharacters: 100,
    timers: recorded.timers,
    onBatch: async (batch) => {
      delivered.push(...batch.map((entry) => entry.id));
      await delivery.promise;
    },
  });
  await batcher.add(message("one", 1));

  let stopped = false;
  const stop = batcher.stop("flush").then(() => {
    stopped = true;
  });
  await Promise.resolve();

  expect(delivered).toEqual(["one"]);
  expect(stopped).toBe(false);
  expect(recorded.intervals[0]).toBeDefined();
  if (recorded.intervals[0]) {
    expect(recorded.cleared).toContain(recorded.intervals[0].handle);
  }
  expect(batcher.stopped).toBe(true);

  delivery.resolve();
  await stop;
  expect(stopped).toBe(true);
  await expect(batcher.add(message("late", 2))).rejects.toThrow("stopped");
});

test("stop cancel drops the open window but waits for selected batches", async () => {
  const recorded = createRecordedTimers();
  const delivery = deferred();
  const delivered: string[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 2,
    maxCharacters: 100,
    timers: recorded.timers,
    onBatch: async (batch) => {
      delivered.push(...batch.map((entry) => entry.id));
      await delivery.promise;
    },
  });

  await batcher.add(message("selected-one", 1));
  const selected = batcher.add(message("selected-two", 2));
  await Promise.resolve();
  await batcher.add(message("cancelled", 3));

  let stopFinished = false;
  const stop = batcher.stop("cancel").then(() => {
    stopFinished = true;
  });
  await Promise.resolve();
  expect(stopFinished).toBe(false);
  expect(batcher.pendingMessages).toBe(0);

  delivery.resolve();
  await Promise.all([selected, stop]);
  expect(delivered).toEqual(["selected-one", "selected-two"]);
});

test("a failed delivery does not duplicate messages or poison later batches", async () => {
  const recorded = createRecordedTimers();
  const attempts: string[] = [];
  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 100,
    maxMessages: 1,
    maxCharacters: 100,
    timers: recorded.timers,
    onBatch: (batch) => {
      const id = batch[0]?.id ?? "missing";
      attempts.push(id);
      if (id === "one") throw new Error("delivery failed");
    },
  });

  await expect(batcher.add(message("one", 1))).rejects.toThrow(
    "delivery failed",
  );
  await batcher.add(message("two", 2));
  await batcher.flush();

  expect(attempts).toEqual(["one", "two"]);
  await batcher.stop("cancel");
});

test("validates limits and character measurements", async () => {
  const recorded = createRecordedTimers();
  expect(() =>
    createDiscordObserverBatcher<Message>({
      flushIntervalMs: 0,
      maxMessages: 1,
      maxCharacters: 1,
      timers: recorded.timers,
      onBatch: () => undefined,
    }),
  ).toThrow("flushIntervalMs");

  const batcher = createDiscordObserverBatcher<Message>({
    flushIntervalMs: 1,
    maxMessages: 1,
    maxCharacters: 1,
    timers: recorded.timers,
    measureCharacters: () => Number.NaN,
    onBatch: () => undefined,
  });
  await expect(batcher.add(message("one", 1))).rejects.toThrow(
    "non-negative number",
  );
  expect(batcher.pendingMessages).toBe(0);
  await batcher.stop("cancel");
});
