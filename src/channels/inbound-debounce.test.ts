import { beforeEach, describe, expect, test } from "bun:test";
import { createInboundDebouncer } from "@/channels/inbound-debounce";

type Item = { key: string | null; value: string };

function defer<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("createInboundDebouncer", () => {
  let flushed: string[][];

  beforeEach(() => {
    flushed = [];
  });

  test("flushes a single item after the debounce window", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    expect(flushed).toEqual([]);
    await sleep(50);
    expect(flushed).toEqual([["a"]]);
  });

  test("two items within the window flush together (trailing edge)", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 25,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    await sleep(10);
    await debouncer.enqueue({ key: "k", value: "b" });
    await sleep(10);
    await debouncer.enqueue({ key: "k", value: "c" });
    expect(flushed).toEqual([]);
    await sleep(60);
    expect(flushed).toEqual([["a", "b", "c"]]);
  });

  test("timer resets each time a new item arrives", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 30,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    await sleep(20);
    expect(flushed).toEqual([]);
    await debouncer.enqueue({ key: "k", value: "b" });
    await sleep(20);
    expect(flushed).toEqual([]);
    await sleep(40);
    expect(flushed).toEqual([["a", "b"]]);
  });

  test("different keys do not merge", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "a", value: "a1" });
    await debouncer.enqueue({ key: "b", value: "b1" });
    await debouncer.enqueue({ key: "a", value: "a2" });
    await sleep(50);
    const sorted = flushed.map((batch) => [...batch].sort()).sort();
    expect(sorted).toEqual([["a1", "a2"], ["b1"]]);
  });

  test("debounceMs: 0 flushes immediately", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    await flushMicrotasks();
    expect(flushed).toEqual([["a"]]);
  });

  test("shouldDebounce false flushes immediately but preserves same-key ordering", async () => {
    const blocker = defer<void>();
    const flushOrder: string[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 25,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => !item.value.startsWith("immediate"),
      onFlush: async (items) => {
        for (const item of items) {
          if (item.value === "a") {
            await blocker.promise;
          }
          flushOrder.push(item.value);
        }
      },
    });

    const bufferedDispatch = debouncer.enqueue({ key: "k", value: "a" });
    const immediate = debouncer.enqueue({ key: "k", value: "immediate-1" });
    await sleep(10);
    expect(flushOrder).toEqual([]);
    blocker.resolve();
    await sleep(60);
    await bufferedDispatch;
    await immediate;
    expect(flushOrder).toEqual(["a", "immediate-1"]);
  });

  test("flushKey forces an immediate flush", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 1000,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    await debouncer.enqueue({ key: "k", value: "b" });
    expect(flushed).toEqual([]);
    await debouncer.flushKey("k");
    expect(flushed).toEqual([["a", "b"]]);
  });

  test("flushAll forces every pending key to flush", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 1000,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "a", value: "a1" });
    await debouncer.enqueue({ key: "b", value: "b1" });
    await debouncer.enqueue({ key: "a", value: "a2" });
    await debouncer.flushAll();
    const sorted = flushed.map((batch) => [...batch].sort()).sort();
    expect(sorted).toEqual([["a1", "a2"], ["b1"]]);
  });

  test("cancelAll drops pending debounced buffers", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 20,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "k", value: "a" });
    debouncer.cancelAll();
    await sleep(50);
    expect(flushed).toEqual([]);
    await debouncer.enqueue({ key: "k", value: "b" });
    await sleep(50);
    expect(flushed).toEqual([["b"]]);
  });

  test("null key forces immediate flush", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: null, value: "x" });
    await flushMicrotasks();
    expect(flushed).toEqual([["x"]]);
  });

  test("maxTrackedKeys saturation falls back to immediate keyed work", async () => {
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 1000,
      maxTrackedKeys: 2,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        flushed.push(items.map((i) => i.value));
      },
    });

    await debouncer.enqueue({ key: "a", value: "a1" });
    await debouncer.enqueue({ key: "b", value: "b1" });
    expect(flushed).toEqual([]);
    await debouncer.enqueue({ key: "c", value: "c1" });
    await flushMicrotasks();
    expect(flushed).toEqual([["c1"]]);
  });

  test("onError is called when onFlush throws; pipeline keeps running", async () => {
    const errors: string[] = [];
    const debouncer = createInboundDebouncer<Item>({
      debounceMs: 10,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        if (items.some((i) => i.value === "boom")) {
          throw new Error("boom");
        }
        flushed.push(items.map((i) => i.value));
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });

    await debouncer.enqueue({ key: "k", value: "boom" });
    await sleep(30);
    expect(errors).toEqual(["boom"]);
    await debouncer.enqueue({ key: "k", value: "ok" });
    await sleep(30);
    expect(flushed).toEqual([["ok"]]);
  });
});
