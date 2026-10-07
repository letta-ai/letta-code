import {
  deleteCurrentEntry,
  dispositionKey,
  durableTransaction,
  expireAcceptedInputDispositions,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import {
  rebuildDispositionCapacityCounts,
  rebuildDispositionExpiryQueue,
} from "./input-disposition-capacity";
import {
  buildLegacyAuthorityQuarantineIndex,
  preparedTerminalMatchesLegacyAuthorityIndex,
  settleExpiredQuarantineJournals,
} from "./input-disposition-retention";
import { TURN_FINISHED_REPLAY_TTL_MS } from "./turn-finished-replay";
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

function hasLegacyAuthorityQuarantine(
  entries: Iterable<AcceptedInputDispositionEntry>,
  terminal: DurablePreparedInputTerminal,
): boolean {
  const recoveryLineageId = terminal.owner.recoveryLineageId;
  const interruptedRevision = terminal.owner.interruptedRevision;
  if (!recoveryLineageId || !interruptedRevision) return false;
  for (const entry of entries) {
    const quarantined = entry.legacyAuthorityQuarantine;
    if (
      quarantined?.scope.agentId === terminal.scope.agentId &&
      quarantined.scope.conversationId === terminal.scope.conversationId &&
      quarantined.recoveryLineageId === recoveryLineageId &&
      quarantined.interruptedRevision === interruptedRevision &&
      quarantined.expiresAt > Date.now()
    ) {
      return true;
    }
  }
  return false;
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
        if (
          hasLegacyAuthorityQuarantine(Object.values(store.entries), terminal)
        ) {
          syncMemoryFromDurable(ledger, store);
          return { result: false, changed: false };
        }
        for (const key of keys) {
          const entry = store.entries[key];
          if (
            entry &&
            (!entry.disposition ||
              entry.disposition === "queued" ||
              entry.legacyAuthorityQuarantine)
          ) {
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
  if (hasLegacyAuthorityQuarantine(ledger.entries.values(), terminal)) {
    return false;
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (
      entry &&
      (!entry.disposition ||
        entry.disposition === "queued" ||
        entry.legacyAuthorityQuarantine)
    ) {
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
    const values = [...entries];
    const quarantines = buildLegacyAuthorityQuarantineIndex(values);
    const byTurnId = new Map<string, DurablePreparedInputTerminal>();
    for (const entry of values) {
      const prepared = entry.preparedTerminal;
      if (
        prepared &&
        preparedTerminalMatchesLegacyAuthorityIndex(entry, quarantines)
      ) {
        continue;
      }
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
    const now = Date.now();
    const nextExpiry = ledger.expiryQueue[ledger.expiryQueueHead];
    const expiryWillSettle = Boolean(nextExpiry && nextExpiry.expiresAt <= now);
    expireAcceptedInputDispositions(ledger, now);
    if (!expiryWillSettle && ledger.quarantinedCount > 0) {
      settleExpiredQuarantineJournals(ledger.entries, now, (key, entry) =>
        deleteCurrentEntry(ledger, key, entry.generation),
      );
    }
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

export function publishPreparedInputTerminalIfCurrent(
  listener: ListenerRuntime,
  terminal: DurablePreparedInputTerminal,
  publish: () => void,
): boolean {
  const ledger = getLedger(listener);
  const publishCurrent = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    const values = [...entries];
    const quarantines = buildLegacyAuthorityQuarantineIndex(values);
    const current = values.some((entry) => {
      if (preparedTerminalMatchesLegacyAuthorityIndex(entry, quarantines)) {
        return false;
      }
      return (
        entry.preparedTerminal !== undefined &&
        JSON.stringify(entry.preparedTerminal) === JSON.stringify(terminal)
      );
    });
    if (current) publish();
    return current;
  };
  if (!ledger.persistentPath) {
    const now = Date.now();
    expireAcceptedInputDispositions(ledger, now);
    settleExpiredQuarantineJournals(ledger.entries, now, (key, entry) =>
      deleteCurrentEntry(ledger, key, entry.generation),
    );
    return publishCurrent(ledger.entries.values());
  }
  return durableTransaction(ledger.persistentPath, (store) => {
    const result = publishCurrent(Object.values(store.entries));
    syncMemoryFromDurable(ledger, store);
    return { result, changed: false };
  });
}

/**
 * Convert unresolved predecessor journals into a stable migration fence.
 * Only pre-sequence/pre-identity authorities can reach this path, so its
 * cardinality is bounded by the already-capped pre-upgrade ledger.
 */
export function quarantinePreparedTerminalAuthority(
  listener: ListenerRuntime,
  scope: { agentId: string | null; conversationId: string },
  authority: NonNullable<
    AcceptedInputDispositionEntry["completedTerminalAuthority"]
  >,
): boolean {
  const recoveryLineageId = authority.recoveryLineageId;
  const interruptedRevision = authority.interruptedRevision;
  if (
    !recoveryLineageId ||
    (authority.terminalIdentity && authority.preparationSequence !== undefined)
  ) {
    return false;
  }
  const ledger = getLedger(listener);
  const mark = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    let matched = false;
    let changed = false;
    const expiresAt = Date.now() + TURN_FINISHED_REPLAY_TTL_MS;
    for (const entry of entries) {
      const prepared = entry.preparedTerminal;
      if (
        prepared?.scope.agentId !== scope.agentId ||
        prepared?.scope.conversationId !== scope.conversationId ||
        prepared.owner.recoveryLineageId !== recoveryLineageId ||
        prepared.owner.interruptedRevision !== interruptedRevision
      )
        continue;
      matched = true;
      if (!entry.legacyAuthorityQuarantine) {
        entry.legacyAuthorityQuarantine = {
          scope: structuredClone(prepared.scope),
          recoveryLineageId,
          interruptedRevision,
          expiresAt,
        };
        delete entry.preparedTerminal;
        entry.expiresAt = expiresAt;
        changed = true;
      }
    }
    return { matched, changed };
  };
  if (!ledger.persistentPath) {
    const result = mark(ledger.entries.values());
    if (result.changed) {
      rebuildDispositionCapacityCounts(ledger);
      rebuildDispositionExpiryQueue(ledger);
    }
    return result.matched;
  }
  return durableTransaction(ledger.persistentPath, (store) => {
    const result = mark(Object.values(store.entries));
    syncMemoryFromDurable(ledger, store);
    return { result: result.matched, changed: result.changed };
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
          entry.completedTerminalAuthority?.recoveryLineageId,
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
  if (!ledger.persistentPath) {
    expireAcceptedInputDispositions(ledger, Date.now());
    return collect(ledger.entries.values());
  }
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return {
      result: collect(Object.values(store.entries)),
      changed: false,
    };
  });
}

export function loadLegacyAuthorityQuarantines(
  listener: ListenerRuntime,
): NonNullable<AcceptedInputDispositionEntry["legacyAuthorityQuarantine"]>[] {
  const ledger = getLedger(listener);
  const collect = (entries: Iterable<AcceptedInputDispositionEntry>) => {
    const quarantines = new Map<
      string,
      NonNullable<AcceptedInputDispositionEntry["legacyAuthorityQuarantine"]>
    >();
    for (const entry of entries) {
      const quarantine = entry.legacyAuthorityQuarantine;
      if (!quarantine) continue;
      quarantines.set(
        JSON.stringify([
          quarantine.scope.agentId,
          quarantine.scope.conversationId,
          quarantine.recoveryLineageId,
          quarantine.interruptedRevision,
        ]),
        structuredClone(quarantine),
      );
    }
    return [...quarantines.values()];
  };
  if (!ledger.persistentPath) {
    expireAcceptedInputDispositions(ledger, Date.now());
    return collect(ledger.entries.values());
  }
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
