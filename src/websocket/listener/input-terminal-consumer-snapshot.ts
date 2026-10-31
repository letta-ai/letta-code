import {
  dispositionKey,
  durableTransaction,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import type {
  AcceptedInputDispositionEntry,
  ConversationRuntime,
  InputIdentity,
} from "./types";

export function snapshotInputTerminalConsumers(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
  initial: readonly string[],
): string[] {
  const keys = [
    ...new Set(
      identities.map((identity) => dispositionKey(runtime.key, identity)),
    ),
  ];
  const ledger = getLedger(runtime.listener);
  const collect = (
    entries: ReadonlyMap<string, AcceptedInputDispositionEntry>,
  ) => {
    const consumers = new Set(initial);
    for (const key of keys) {
      const entry = entries.get(key);
      for (const consumerId of entry?.queuedInput?.incoming
        .terminalConsumerIds ?? []) {
        consumers.add(consumerId);
      }
    }
    return [...consumers];
  };
  if (!ledger.persistentPath) return collect(ledger.entries);
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return {
      result: collect(new Map(Object.entries(store.entries))),
      changed: false,
    };
  });
}
