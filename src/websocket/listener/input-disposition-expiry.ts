import {
  buildLegacyAuthorityReferenceIndex,
  settleExpiredQuarantineJournals,
  shouldRetainDisposition,
} from "./input-disposition-retention";
import type { AcceptedInputDispositionLedger } from "./types";

export function expireDispositionEntries(
  ledger: AcceptedInputDispositionLedger,
  now: number,
  ttlMs: number,
  deleteCurrent: (key: string, generation: number) => boolean,
): void {
  const nextExpiry = ledger.expiryQueue[ledger.expiryQueueHead];
  if (!nextExpiry || nextExpiry.expiresAt > now) return;
  let references: ReadonlySet<string> | undefined;
  settleExpiredQuarantineJournals(ledger.entries, now, (key, entry) => {
    deleteCurrent(key, entry.generation);
  });
  while (ledger.expiryQueueHead < ledger.expiryQueue.length) {
    const expiry = ledger.expiryQueue[ledger.expiryQueueHead];
    if (!expiry || expiry.expiresAt > now) break;
    ledger.expiryQueueHead += 1;
    const entry = ledger.entries.get(expiry.key);
    if (
      entry?.generation === expiry.generation &&
      entry.expiresAt !== expiry.expiresAt
    ) {
      continue;
    }
    if (
      entry?.generation === expiry.generation &&
      shouldRetainDisposition(entry, () => {
        references ??= buildLegacyAuthorityReferenceIndex(
          ledger.entries.values(),
        );
        return references;
      })
    ) {
      entry.expiresAt = now + ttlMs;
      ledger.expiryQueue.push({
        key: expiry.key,
        expiresAt: entry.expiresAt,
        generation: entry.generation,
      });
    } else {
      deleteCurrent(expiry.key, expiry.generation);
    }
  }
  if (
    ledger.expiryQueueHead >= 1024 &&
    ledger.expiryQueueHead * 2 >= ledger.expiryQueue.length
  ) {
    ledger.expiryQueue = ledger.expiryQueue.slice(ledger.expiryQueueHead);
    ledger.expiryQueueHead = 0;
  }
}
