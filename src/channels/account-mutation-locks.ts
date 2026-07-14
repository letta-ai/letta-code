type PendingChannelSecretWrite = {
  channelId: string;
  accountId: string;
  fieldPath: string;
  promise: Promise<unknown>;
};

type PendingChannelSecretWriteFilter = {
  channelId?: string;
  accountId?: string;
};

let pendingSecretWrites: PendingChannelSecretWrite[] = [];
const accountMutationLocks = new Map<string, Promise<void>>();

function matchesPendingSecretWrite(
  write: PendingChannelSecretWrite,
  filter: PendingChannelSecretWriteFilter,
): boolean {
  return (
    (!filter.channelId || write.channelId === filter.channelId) &&
    (!filter.accountId || write.accountId === filter.accountId)
  );
}

export function queueSecretWrite(
  channelId: string,
  accountId: string,
  fieldPath: string,
  promise: Promise<unknown>,
): void {
  // Attach a rejection handler immediately so detached background writes cannot
  // become unhandled rejections. Keep the original promise in the queue so
  // foreground secret-aware operations can await and surface targeted failures.
  promise.catch(() => {});
  pendingSecretWrites.push({ channelId, accountId, fieldPath, promise });
}

export async function withAccountMutationLock<T>(
  channelId: string,
  accountId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${channelId}\0${accountId}`;
  const previous = accountMutationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  accountMutationLocks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (accountMutationLocks.get(key) === tail) {
      accountMutationLocks.delete(key);
    }
  }
}

export async function flushPendingChannelSecretWrites(
  filter: PendingChannelSecretWriteFilter = {},
): Promise<void> {
  while (true) {
    const writes = pendingSecretWrites.filter((write) =>
      matchesPendingSecretWrite(write, filter),
    );
    if (writes.length === 0) {
      return;
    }

    pendingSecretWrites = pendingSecretWrites.filter(
      (write) => !matchesPendingSecretWrite(write, filter),
    );
    const results = await Promise.allSettled(
      writes.map((write) => write.promise),
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw failed.reason;
    }
  }
}

export function clearChannelAccountMutationState(): void {
  pendingSecretWrites = [];
  accountMutationLocks.clear();
}
