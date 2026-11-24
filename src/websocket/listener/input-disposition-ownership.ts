import {
  dispositionKey,
  durableTransaction,
  expireAcceptedInputDispositions,
  getLedger,
  MAX_DURABLE_QUEUED_INPUT_BYTES,
  syncMemoryFromDurable,
} from "./input-disposition";
import type {
  AcceptedInputDispositionEntry,
  ConversationRuntime,
  InputIdentity,
} from "./types";

const MAX_LATE_TERMINAL_CONSUMERS_PER_INPUT = 64;

function entryHasLiveAcceptedInputOwner(
  entry: AcceptedInputDispositionEntry | undefined,
): entry is AcceptedInputDispositionEntry {
  if (!entry || entry.expiresAt <= Date.now()) return false;
  if (entry.disposition !== "started" && entry.disposition !== "queued") {
    return false;
  }
  return (
    !entry.replayCompleted &&
    !entry.preparedTerminal &&
    !entry.completedTerminalRevision &&
    !entry.completedTerminalAuthority
  );
}

function readInputDispositionEntry(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): AcceptedInputDispositionEntry | undefined {
  if (!identity) return undefined;
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, identity);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        syncMemoryFromDurable(ledger, store);
        return {
          result: store.entries[key] ?? undefined,
          changed: false,
        };
      });
    } catch {
      return undefined;
    }
  }
  expireAcceptedInputDispositions(ledger, Date.now());
  return ledger.entries.get(key) ?? undefined;
}

export function hasLiveAcceptedInputOwner(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): boolean {
  return entryHasLiveAcceptedInputOwner(
    readInputDispositionEntry(runtime, identity),
  );
}

export function attachTerminalConsumerToLiveAcceptedInput(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
  terminalConsumerId: string | undefined,
): boolean {
  if (!identity || !terminalConsumerId) return false;
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, identity);
  const attach = (
    entry: AcceptedInputDispositionEntry | undefined,
  ): boolean => {
    if (!entryHasLiveAcceptedInputOwner(entry) || !entry.queuedInput) {
      return false;
    }
    const incoming = entry.queuedInput.incoming;
    const previousConsumers = incoming.terminalConsumerIds;
    const nextConsumers = [
      ...new Set([...(incoming.terminalConsumerIds ?? []), terminalConsumerId]),
    ];
    if (nextConsumers.length > MAX_LATE_TERMINAL_CONSUMERS_PER_INPUT) {
      return false;
    }
    incoming.terminalConsumerIds = nextConsumers;
    if (
      Buffer.byteLength(JSON.stringify(entry.queuedInput)) >
      MAX_DURABLE_QUEUED_INPUT_BYTES
    ) {
      incoming.terminalConsumerIds = previousConsumers;
      return false;
    }
    return true;
  };
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        const attached = attach(store.entries[key]);
        syncMemoryFromDurable(ledger, store);
        return { result: attached, changed: attached };
      });
    } catch {
      return false;
    }
  }
  expireAcceptedInputDispositions(ledger, Date.now());
  return attach(ledger.entries.get(key));
}

export function liveAcceptedInputOwnerProof(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): (() => boolean) | undefined {
  return identity
    ? () => hasLiveAcceptedInputOwner(runtime, identity)
    : undefined;
}

export function hasLiveAcceptedInputOwnerWithOriginatorRetirement(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): boolean {
  if (!hasLiveAcceptedInputOwner(runtime, identity)) return false;
  const entry = readInputDispositionEntry(runtime, identity);
  const owner = (
    entry?.queuedInput?.incoming as
      | { mcpOriginatorSuperRunId?: unknown }
      | undefined
  )?.mcpOriginatorSuperRunId;
  return typeof owner === "string" && owner.length > 0;
}
