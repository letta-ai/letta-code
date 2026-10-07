import { isLegacyAuthorityQuarantine } from "./input-disposition-retention";
import type {
  AcceptedInputDispositionEntry,
  AcceptedInputDispositionLedger,
} from "./types";

export function rebuildDispositionCapacityCounts(
  ledger: AcceptedInputDispositionLedger,
): void {
  ledger.scopeCounts.clear();
  ledger.quarantinedCount = 0;
  for (const entry of ledger.entries.values()) {
    if (isLegacyAuthorityQuarantine(entry)) ledger.quarantinedCount += 1;
    else
      ledger.scopeCounts.set(
        entry.runtimeKey,
        (ledger.scopeCounts.get(entry.runtimeKey) ?? 0) + 1,
      );
  }
}

export function removeDispositionCapacityEntry(
  ledger: AcceptedInputDispositionLedger,
  entry: AcceptedInputDispositionEntry,
): void {
  if (isLegacyAuthorityQuarantine(entry)) {
    ledger.quarantinedCount -= 1;
    return;
  }
  const next = (ledger.scopeCounts.get(entry.runtimeKey) ?? 1) - 1;
  if (next === 0) ledger.scopeCounts.delete(entry.runtimeKey);
  else ledger.scopeCounts.set(entry.runtimeKey, next);
}

export function countCapacityEntries(
  entries: readonly AcceptedInputDispositionEntry[],
): number {
  return entries.filter((entry) => !isLegacyAuthorityQuarantine(entry)).length;
}

export function activeDispositionCount(
  ledger: AcceptedInputDispositionLedger,
): number {
  return ledger.entries.size - ledger.quarantinedCount;
}

export function compactDispositionExpiryQueue(
  ledger: AcceptedInputDispositionLedger,
): void {
  const remaining = ledger.expiryQueue.length - ledger.expiryQueueHead;
  if (remaining < 1024 || remaining <= ledger.entries.size * 2 + 1024) return;
  ledger.expiryQueue = ledger.expiryQueue
    .slice(ledger.expiryQueueHead)
    .filter((expiry) => {
      const entry = ledger.entries.get(expiry.key);
      return entry?.generation === expiry.generation;
    });
  ledger.expiryQueueHead = 0;
}

export function rebuildDispositionExpiryQueue(
  ledger: AcceptedInputDispositionLedger,
): void {
  ledger.expiryQueue = [...ledger.entries].map(([key, entry]) => ({
    key,
    expiresAt: entry.expiresAt,
    generation: entry.generation,
  }));
  ledger.expiryQueue.sort((left, right) => left.expiresAt - right.expiresAt);
  ledger.expiryQueueHead = 0;
}
