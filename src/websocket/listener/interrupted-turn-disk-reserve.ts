import { withDiskReserveRetry } from "@/utils/disk-reserve";

const writes = [
  "write",
  "writeWithRecoveryAuthority",
  "writeRecoveryLineageSnapshot",
  "mergeSettledRecoveryResult",
  "markRecoveryClaimCompletionPending",
  "retireRecoveryClaimCompletion",
  "remove",
  "compactRetiredRecoverySidecar",
  "removeRetiredRecoverySidecar",
] as const;

type WriteMethod = (typeof writes)[number];

export function withInterruptedTurnDiskReserve<
  T extends Record<WriteMethod, (...args: never[]) => unknown>,
>(directory: string, store: T): T {
  const wrapped = { ...store };
  for (const key of writes) {
    const operation = store[key];
    wrapped[key] = ((...args: never[]) =>
      withDiskReserveRetry(directory, () =>
        operation(...args),
      )) as T[typeof key];
  }
  return wrapped;
}
