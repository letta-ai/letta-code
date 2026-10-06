import {
  dispositionKey,
  durableTransaction,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import type {
  AcceptedInputDispositionEntry,
  ConversationRuntime,
  DurablePreparedInputTerminal,
  InputIdentity,
  ListenerRuntime,
} from "./types";

function identityKeys(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
): string[] {
  return [
    ...new Set(
      identities.map((identity) => dispositionKey(runtime.key, identity)),
    ),
  ];
}

/**
 * Atomically replace replayable input with its terminal intent. A restart may
 * promote this journal entry to the terminal replay store, but must never run
 * the accepted input again after its side effects have completed.
 */
export function prepareInputTerminal(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
  terminal: DurablePreparedInputTerminal,
): boolean {
  if (identities.length === 0) return true;
  const ledger = getLedger(runtime.listener);
  const keys = identityKeys(runtime, identities);
  const prepared = structuredClone(terminal);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        for (const key of keys) {
          const entry = store.entries[key];
          if (entry && (!entry.disposition || entry.disposition === "queued")) {
            syncMemoryFromDurable(ledger, store);
            return { result: false, changed: false };
          }
        }
        let changed = false;
        for (const key of keys) {
          const entry = store.entries[key];
          if (!entry) continue;
          delete entry.queuedInput;
          entry.replayCompleted = true;
          entry.preparedTerminal = prepared;
          changed = true;
        }
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed };
      });
    } catch {
      return false;
    }
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (entry && (!entry.disposition || entry.disposition === "queued")) {
      return false;
    }
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (!entry) continue;
    delete entry.queuedInput;
    entry.replayCompleted = true;
    entry.preparedTerminal = prepared;
  }
  return true;
}

/** Clear a journal only after its terminal has another durable home. */
export function completePreparedInputTerminal(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
  turnId: string,
): boolean {
  if (identities.length === 0) return true;
  const ledger = getLedger(runtime.listener);
  const keys = identityKeys(runtime, identities);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        let changed = false;
        for (const key of keys) {
          const entry = store.entries[key];
          if (entry?.preparedTerminal?.message.turn_id === turnId) {
            if (entry.preparedTerminal.owner.interruptedRevision) {
              entry.completedTerminalRevision =
                entry.preparedTerminal.owner.interruptedRevision;
            }
            delete entry.preparedTerminal;
            changed = true;
          }
        }
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed };
      });
    } catch {
      return false;
    }
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (entry?.preparedTerminal?.message.turn_id === turnId) {
      if (entry.preparedTerminal.owner.interruptedRevision) {
        entry.completedTerminalRevision =
          entry.preparedTerminal.owner.interruptedRevision;
      }
      delete entry.preparedTerminal;
    }
  }
  return true;
}

/** Read deduplicated terminal journals under the same lock as input replay. */
export function loadPreparedInputTerminals(
  listener: ListenerRuntime,
): DurablePreparedInputTerminal[] {
  const ledger = getLedger(listener);
  const collect = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    const byTurnId = new Map<string, DurablePreparedInputTerminal>();
    for (const entry of entries) {
      const prepared = entry.preparedTerminal;
      if (prepared) {
        const key =
          prepared.owner.terminalIdentity ??
          JSON.stringify([
            prepared.scope.agentId,
            prepared.scope.conversationId,
            prepared.message.turn_id,
          ]);
        const existing = byTurnId.get(key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(prepared)) {
          throw new Error("Prepared terminal identity collision");
        }
        byTurnId.set(key, structuredClone(prepared));
      }
    }
    return [...byTurnId.values()];
  };
  if (!ledger.persistentPath) return collect(ledger.entries.values());
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return {
      result: collect(Object.values(store.entries)),
      changed: false,
    };
  });
}

export function hasPreparedInputTerminalRevision(
  listener: ListenerRuntime,
  scope: DurablePreparedInputTerminal["scope"],
  interruptedRevision: string,
): boolean {
  return loadPreparedInputTerminals(listener).some(
    (prepared) =>
      prepared.scope.agentId === scope.agentId &&
      prepared.scope.conversationId === scope.conversationId &&
      prepared.owner.interruptedRevision === interruptedRevision,
  );
}

export function clearPreparedInputTerminal(
  listener: ListenerRuntime,
  scope: DurablePreparedInputTerminal["scope"],
  turnId: string,
  terminalIdentity?: string,
): boolean {
  const ledger = getLedger(listener);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        let changed = false;
        for (const entry of Object.values(store.entries)) {
          const prepared = entry.preparedTerminal;
          if (!prepared) continue;
          if (
            (terminalIdentity
              ? prepared.owner.terminalIdentity === terminalIdentity
              : prepared.message.turn_id === turnId) &&
            prepared.scope.agentId === scope.agentId &&
            prepared.scope.conversationId === scope.conversationId
          ) {
            if (prepared.owner.interruptedRevision) {
              entry.completedTerminalRevision =
                prepared.owner.interruptedRevision;
            }
            delete entry.preparedTerminal;
            changed = true;
          }
        }
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed };
      });
    } catch {
      return false;
    }
  }
  for (const entry of ledger.entries.values()) {
    const prepared = entry.preparedTerminal;
    if (!prepared) continue;
    if (
      (terminalIdentity
        ? prepared.owner.terminalIdentity === terminalIdentity
        : prepared.message.turn_id === turnId) &&
      prepared.scope.agentId === scope.agentId &&
      prepared.scope.conversationId === scope.conversationId
    ) {
      if (prepared.owner.interruptedRevision) {
        entry.completedTerminalRevision = prepared.owner.interruptedRevision;
      }
      delete entry.preparedTerminal;
    }
  }
  return true;
}

/** Atomically retain disposition tombstones while retiring replay payloads. */
export function completeInputReplay(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
): boolean {
  if (identities.length === 0) return true;
  const ledger = getLedger(runtime.listener);
  const keys = identityKeys(runtime, identities);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        for (const key of keys) {
          const entry = store.entries[key];
          if (entry && (!entry.disposition || entry.disposition === "queued")) {
            syncMemoryFromDurable(ledger, store);
            return { result: false, changed: false };
          }
        }
        let changed = false;
        for (const key of keys) {
          const entry = store.entries[key];
          if (!entry) continue;
          if (entry.queuedInput !== undefined) {
            delete entry.queuedInput;
            entry.replayCompleted = true;
            changed = true;
          }
        }
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed };
      });
    } catch {
      return false;
    }
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (!entry) continue;
    if (!entry.disposition || entry.disposition === "queued") return false;
    delete entry.queuedInput;
    entry.replayCompleted = true;
  }
  return true;
}
