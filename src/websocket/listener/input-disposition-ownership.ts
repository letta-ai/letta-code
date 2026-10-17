/**
 * Durable input-ownership reads derived from the accepted-input disposition
 * ledger. Lives outside input-disposition.ts to keep that module under the
 * source-file size cap; all ledger access goes through its exported helpers.
 */

import {
  dispositionKey,
  durableTransaction,
  expireAcceptedInputDispositions,
  getLedger,
  syncMemoryFromDurable,
} from "./input-disposition";
import type {
  AcceptedInputDispositionEntry,
  ConversationRuntime,
  InputIdentity,
} from "./types";

/**
 * Read the full durable disposition entry for one identity, following the
 * same durable-first / in-memory fallback pattern as getInputDisposition.
 */
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

/**
 * Whether the durable ledger still shows a LIVE accepted owner for this
 * input: a started or queued disposition that has not replay-completed, has
 * not been terminal-prepared, and has no completed terminal outcome. This is
 * the proof the MCP originator token store needs before (re)creating an
 * entry for a refresh-path delivery after a process crash or ACK loss — a
 * live disposition means a finalizer still exists for the work, while a
 * terminal tombstone means the run is done and any re-delivered token would
 * be orphaned. Expired entries are not live.
 */
export function hasLiveAcceptedInputOwner(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): boolean {
  const entry = readInputDispositionEntry(runtime, identity);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) return false;
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

/**
 * The mayRecreateOwner callback shape the originator token ack path needs:
 * undefined when the input has no identity (nothing provable), otherwise a
 * thunk proving the durable ledger still shows a live accepted owner.
 */
export function liveAcceptedInputOwnerProof(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): (() => boolean) | undefined {
  return identity
    ? () => hasLiveAcceptedInputOwner(runtime, identity)
    : undefined;
}
