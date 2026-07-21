import type { ListenerRuntime } from "./types";

type ChannelReloadBarrier = {
  depth: number;
  promise: Promise<void>;
  resolve: () => void;
};

const barriers = new WeakMap<ListenerRuntime, ChannelReloadBarrier>();

export function beginChannelReloadBarrier(
  listener: ListenerRuntime,
): () => void {
  const existing = barriers.get(listener);
  if (existing) {
    existing.depth += 1;
  } else {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((complete) => {
      resolve = complete;
    });
    barriers.set(listener, { depth: 1, promise, resolve });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const barrier = barriers.get(listener);
    if (!barrier) return;
    barrier.depth -= 1;
    if (barrier.depth > 0) return;
    barriers.delete(listener);
    barrier.resolve();
  };
}

export function getChannelReloadBarrier(
  listener: ListenerRuntime,
): Promise<void> | null {
  return barriers.get(listener)?.promise ?? null;
}
