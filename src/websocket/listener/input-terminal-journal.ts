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

function recordCompletedTerminalAuthority(
  entry: AcceptedInputDispositionEntry,
  owner: DurablePreparedInputTerminal["owner"],
): void {
  if (!owner.interruptedRevision) return;
  entry.completedTerminalRevision = owner.interruptedRevision;
  entry.completedTerminalAuthority = {
    interruptedRevision: owner.interruptedRevision,
    authorityRevision:
      owner.interruptedAuthorityRevision ?? owner.interruptedRevision,
    ...(owner.recoveryLineageId
      ? { recoveryLineageId: owner.recoveryLineageId }
      : {}),
    ...(owner.terminalIdentity
      ? { terminalIdentity: owner.terminalIdentity }
      : {}),
    ...(owner.preparationSequence !== undefined
      ? { preparationSequence: owner.preparationSequence }
      : {}),
  };
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
  const preparedBase = structuredClone(terminal);
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
        const preparationSequence =
          terminal.preparationSequence ?? ++store.nextGeneration;
        const prepared = {
          ...preparedBase,
          preparedAt: terminal.preparedAt ?? Date.now(),
          preparationSequence,
          owner: { ...preparedBase.owner, preparationSequence },
        };
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
  const preparationSequence =
    terminal.preparationSequence ?? ++ledger.nextGeneration;
  const prepared = {
    ...preparedBase,
    preparedAt: terminal.preparedAt ?? Date.now(),
    preparationSequence,
    owner: { ...preparedBase.owner, preparationSequence },
  };
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
            recordCompletedTerminalAuthority(
              entry,
              entry.preparedTerminal.owner,
            );
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
      recordCompletedTerminalAuthority(entry, entry.preparedTerminal.owner);
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
  const backfillPreparationSequence = (
    entries: Iterable<AcceptedInputDispositionEntry>,
  ): boolean => {
    let changed = false;
    for (const entry of entries) {
      const prepared = entry.preparedTerminal;
      if (!prepared) continue;
      const sequence = prepared.preparationSequence ?? entry.generation;
      if (prepared.preparationSequence === undefined) {
        prepared.preparationSequence = sequence;
        changed = true;
      }
      if (prepared.owner.preparationSequence === undefined) {
        prepared.owner.preparationSequence = sequence;
        changed = true;
      }
    }
    return changed;
  };
  const collect = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    const byTurnId = new Map<string, DurablePreparedInputTerminal>();
    for (const entry of entries) {
      const prepared = entry.preparedTerminal;
      if (prepared) {
        const ordered = {
          ...prepared,
          // Pre-sequence journals can only use their durable reservation
          // generation as a stable upgrade order. New writes always carry the
          // exact monotonic preparation sequence.
          preparationSequence: prepared.preparationSequence ?? entry.generation,
          owner: {
            ...prepared.owner,
            preparationSequence:
              prepared.owner.preparationSequence ??
              prepared.preparationSequence ??
              entry.generation,
          },
        };
        const key =
          ordered.owner.terminalIdentity ??
          JSON.stringify([
            ordered.scope.agentId,
            ordered.scope.conversationId,
            ordered.message.turn_id,
          ]);
        const existing = byTurnId.get(key);
        if (existing) {
          const {
            preparationSequence: existingSequence,
            owner: existingOwner,
            ...existingPayload
          } = existing;
          const {
            preparationSequence: orderedSequence,
            owner: orderedOwner,
            ...orderedPayload
          } = ordered;
          const {
            preparationSequence: _existingOwnerSequence,
            ...existingOwnerPayload
          } = existingOwner;
          const {
            preparationSequence: _orderedOwnerSequence,
            ...orderedOwnerPayload
          } = orderedOwner;
          if (
            JSON.stringify({
              ...existingPayload,
              owner: existingOwnerPayload,
            }) !==
            JSON.stringify({ ...orderedPayload, owner: orderedOwnerPayload })
          ) {
            throw new Error("Prepared terminal identity collision");
          }
          if ((orderedSequence ?? -1) > (existingSequence ?? -1)) {
            byTurnId.set(key, structuredClone(ordered));
          }
          continue;
        }
        byTurnId.set(key, structuredClone(ordered));
      }
    }
    return [...byTurnId.values()];
  };
  if (!ledger.persistentPath) {
    backfillPreparationSequence(ledger.entries.values());
    return collect(ledger.entries.values());
  }
  return durableTransaction(ledger.persistentPath, (store) => {
    const changed = backfillPreparationSequence(Object.values(store.entries));
    syncMemoryFromDurable(ledger, store);
    return {
      result: collect(Object.values(store.entries)),
      changed,
    };
  });
}

export function loadCompletedTerminalAuthorities(
  listener: ListenerRuntime,
): Array<{
  runtimeKey: string;
  expiresAt: number;
  authority: NonNullable<
    AcceptedInputDispositionEntry["completedTerminalAuthority"]
  >;
}> {
  const ledger = getLedger(listener);
  const collect = (entries: Iterable<AcceptedInputDispositionEntry>) =>
    [...entries]
      .filter(
        (entry) =>
          entry.expiresAt > Date.now() &&
          entry.completedTerminalAuthority?.recoveryLineageId &&
          entry.completedTerminalAuthority.terminalIdentity &&
          entry.completedTerminalAuthority.preparationSequence !== undefined,
      )
      .map((entry) => ({
        runtimeKey: entry.runtimeKey,
        expiresAt: entry.expiresAt,
        authority: structuredClone(
          entry.completedTerminalAuthority as NonNullable<
            AcceptedInputDispositionEntry["completedTerminalAuthority"]
          >,
        ),
      }));
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

export function hasPreparedInputTerminalAuthority(
  listener: ListenerRuntime,
  scope: DurablePreparedInputTerminal["scope"],
  authority: {
    interruptedRevision: string;
    authorityRevision: string;
    recoveryLineageId?: string;
  },
): boolean {
  return loadPreparedInputTerminals(listener).some(
    (prepared) =>
      prepared.scope.agentId === scope.agentId &&
      prepared.scope.conversationId === scope.conversationId &&
      prepared.owner.interruptedRevision === authority.interruptedRevision &&
      (prepared.owner.interruptedAuthorityRevision ??
        prepared.owner.interruptedRevision) === authority.authorityRevision &&
      prepared.owner.recoveryLineageId === authority.recoveryLineageId,
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
            recordCompletedTerminalAuthority(entry, prepared.owner);
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
      recordCompletedTerminalAuthority(entry, prepared.owner);
      delete entry.preparedTerminal;
    }
  }
  return true;
}

/** Drop stale prepared evidence without claiming it completed a newer authority. */
export function discardPreparedInputTerminal(
  listener: ListenerRuntime,
  scope: DurablePreparedInputTerminal["scope"],
  terminalIdentity: string | undefined,
  turnId: string,
): boolean {
  const ledger = getLedger(listener);
  const discard = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    let changed = false;
    for (const entry of entries) {
      const prepared = entry.preparedTerminal;
      if (!prepared) continue;
      const matches = terminalIdentity
        ? prepared.owner.terminalIdentity === terminalIdentity
        : prepared.message.turn_id === turnId;
      if (
        matches &&
        prepared.scope.agentId === scope.agentId &&
        prepared.scope.conversationId === scope.conversationId
      ) {
        delete entry.preparedTerminal;
        changed = true;
      }
    }
    return changed;
  };
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        const changed = discard(Object.values(store.entries));
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed };
      });
    } catch {
      return false;
    }
  }
  discard(ledger.entries.values());
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
