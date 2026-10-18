import {
  dispositionKey,
  durableTransaction,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import type {
  AcceptedInputDispositionEntry,
  InputIdentity,
  InterruptedTerminalAuthority,
  ListenerRuntime,
} from "./types";

export function hasCompletedInputTerminalRevision(
  listener: ListenerRuntime,
  runtimeKey: string,
  identities: readonly InputIdentity[],
  revision: string,
): boolean {
  if (identities.length === 0) return false;
  const ledger = getLedger(listener);
  const keys = identities.map((identity) =>
    dispositionKey(runtimeKey, identity),
  );
  const matches = (entries: Map<string, AcceptedInputDispositionEntry>) =>
    keys.every(
      (key) => entries.get(key)?.completedTerminalRevision === revision,
    );
  if (!ledger.persistentPath) return matches(ledger.entries);
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return { result: matches(ledger.entries), changed: false };
  });
}

export function hasCompletedInputTerminalAuthority(
  listener: ListenerRuntime,
  runtimeKey: string,
  identities: readonly InputIdentity[],
  authority: InterruptedTerminalAuthority,
): boolean {
  if (identities.length === 0) return false;
  const ledger = getLedger(listener);
  const keys = identities.map((identity) =>
    dispositionKey(runtimeKey, identity),
  );
  const matches = (entries: Map<string, AcceptedInputDispositionEntry>) =>
    keys.every((key) => {
      const completed = entries.get(key)?.completedTerminalAuthority;
      return (
        completed?.interruptedRevision === authority.interruptedRevision &&
        completed.authorityRevision === authority.authorityRevision &&
        completed.recoveryLineageId === authority.recoveryLineageId
      );
    });
  if (!ledger.persistentPath) return matches(ledger.entries);
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return { result: matches(ledger.entries), changed: false };
  });
}
