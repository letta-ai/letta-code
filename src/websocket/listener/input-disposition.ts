import type {
  AcceptedInputDisposition,
  AcceptedInputDispositionLedger,
  ConversationRuntime,
  InputDispositionReservation,
  InputIdentity,
  ListenerRuntime,
} from "./types";

/** Cover Cloud's five ten-minute delivery attempts plus bounded retry backoff. */
export const ACCEPTED_INPUT_DISPOSITION_TTL_MS = 60 * 60 * 1000;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE = 4096;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS = 65_536;

/** A client-chosen `client_message_id`. Never shares keys with teleport ids. */
export function ordinaryInputIdentity(
  clientMessageId: string | undefined,
): InputIdentity | undefined {
  return clientMessageId ? { domain: "input", id: clientMessageId } : undefined;
}

/** A cloud-chosen teleport id. Never shares keys with client message ids. */
export function teleportInputIdentity(teleportId: string): InputIdentity {
  return { domain: "teleport", id: teleportId };
}

function dispositionKey(runtimeKey: string, identity: InputIdentity): string {
  // The domain is its own array element rather than a string prefix so no
  // caller-supplied id can be spelled to land in another domain's key space.
  return JSON.stringify([runtimeKey, identity.domain, identity.id]);
}

export function createAcceptedInputDispositionLedger(): AcceptedInputDispositionLedger {
  return {
    entries: new Map(),
    scopeCounts: new Map(),
    expiryQueue: [],
    expiryQueueHead: 0,
    nextGeneration: 0,
  };
}

function getLedger(listener: ListenerRuntime): AcceptedInputDispositionLedger {
  listener.acceptedInputDispositionLedger ??=
    createAcceptedInputDispositionLedger();
  return listener.acceptedInputDispositionLedger;
}

function decrementScopeCount(
  ledger: AcceptedInputDispositionLedger,
  runtimeKey: string,
): void {
  const next = (ledger.scopeCounts.get(runtimeKey) ?? 1) - 1;
  if (next === 0) ledger.scopeCounts.delete(runtimeKey);
  else ledger.scopeCounts.set(runtimeKey, next);
}

function compactExpiryQueueIfSparse(
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

function deleteCurrentEntry(
  ledger: AcceptedInputDispositionLedger,
  key: string,
  generation?: number,
): boolean {
  const entry = ledger.entries.get(key);
  if (!entry || (generation !== undefined && entry.generation !== generation)) {
    return false;
  }
  ledger.entries.delete(key);
  decrementScopeCount(ledger, entry.runtimeKey);
  compactExpiryQueueIfSparse(ledger);
  return true;
}

/**
 * Expiry records are append-only and accepted timestamps never move. Each record
 * is visited once; stale records from rollback/forget are ignored by generation.
 */
function expireAcceptedInputDispositions(
  ledger: AcceptedInputDispositionLedger,
  now: number,
): void {
  while (ledger.expiryQueueHead < ledger.expiryQueue.length) {
    const expiry = ledger.expiryQueue[ledger.expiryQueueHead];
    if (!expiry || expiry.expiresAt > now) break;
    ledger.expiryQueueHead += 1;
    deleteCurrentEntry(ledger, expiry.key, expiry.generation);
  }

  // Amortized compaction: copying only after at least half the backing array has
  // already been consumed keeps aggregate maintenance linear in insertions.
  if (
    ledger.expiryQueueHead >= 1024 &&
    ledger.expiryQueueHead * 2 >= ledger.expiryQueue.length
  ) {
    ledger.expiryQueue = ledger.expiryQueue.slice(ledger.expiryQueueHead);
    ledger.expiryQueueHead = 0;
  }
}

export type InputDispositionAdmission =
  | { kind: "untracked" }
  | { kind: "duplicate"; disposition: AcceptedInputDisposition }
  | { kind: "reserved"; reservation: InputDispositionReservation }
  | { kind: "full" };

/**
 * Atomically checks a stable ID and reserves ledger capacity. Callers must do
 * this before queue ownership or execution side effects, then commit or roll
 * back the returned reservation.
 */
export function reserveInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): InputDispositionAdmission {
  if (!identity) return { kind: "untracked" };
  const ledger = getLedger(runtime.listener);
  const now = Date.now();
  expireAcceptedInputDispositions(ledger, now);
  const key = dispositionKey(runtime.key, identity);
  const existing = ledger.entries.get(key);
  if (existing) {
    if (existing.disposition) {
      return { kind: "duplicate", disposition: existing.disposition };
    }
    // A reservation can only span synchronous admission work. Treat a reentrant
    // duplicate as unavailable rather than executing it without a tombstone.
    return { kind: "full" };
  }
  if (
    ledger.entries.size >= MAX_ACCEPTED_INPUT_DISPOSITIONS ||
    (ledger.scopeCounts.get(runtime.key) ?? 0) >=
      MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE
  ) {
    return { kind: "full" };
  }

  const generation = ledger.nextGeneration + 1;
  ledger.nextGeneration = generation;
  ledger.entries.set(key, {
    disposition: null,
    acceptedAt: now,
    expiresAt: Number.POSITIVE_INFINITY,
    runtimeKey: runtime.key,
    generation,
  });
  ledger.scopeCounts.set(
    runtime.key,
    (ledger.scopeCounts.get(runtime.key) ?? 0) + 1,
  );
  return {
    kind: "reserved",
    reservation: { key, generation, runtimeKey: runtime.key },
  };
}

export function commitInputDisposition(
  runtime: ConversationRuntime,
  reservation: InputDispositionReservation | undefined,
  disposition: AcceptedInputDisposition,
): void {
  if (!reservation) return;
  const entry = getLedger(runtime.listener).entries.get(reservation.key);
  if (
    entry?.generation === reservation.generation &&
    entry.runtimeKey === runtime.key
  ) {
    if (entry.disposition) return;
    const acceptedAt = Date.now();
    entry.acceptedAt = acceptedAt;
    entry.expiresAt = acceptedAt + ACCEPTED_INPUT_DISPOSITION_TTL_MS;
    entry.disposition = disposition;
    getLedger(runtime.listener).expiryQueue.push({
      key: reservation.key,
      expiresAt: entry.expiresAt,
      generation: entry.generation,
    });
  }
}

/**
 * Releases a reservation that never reached a disposition.
 *
 * Rollback is deliberately commit-aware: once a reservation is committed the
 * side effect it guards is already under way, so an exception unwinding past
 * it must leave the tombstone in place and let the sender's retry observe the
 * real disposition. Only the uncommitted placeholder — which would otherwise
 * never expire and would hold scope capacity forever — is reclaimed.
 */
export function rollbackInputDisposition(
  runtime: ConversationRuntime,
  reservation: InputDispositionReservation | undefined,
): void {
  if (!reservation) return;
  const ledger = getLedger(runtime.listener);
  const entry = ledger.entries.get(reservation.key);
  if (!entry || entry.disposition !== null) return;
  deleteCurrentEntry(ledger, reservation.key, reservation.generation);
}

export function getInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): AcceptedInputDisposition | undefined {
  if (!identity) return undefined;
  const ledger = getLedger(runtime.listener);
  expireAcceptedInputDispositions(ledger, Date.now());
  return (
    ledger.entries.get(dispositionKey(runtime.key, identity))?.disposition ??
    undefined
  );
}

/** Test/setup helper; production ingress should use reserve/commit/rollback. */
export function rememberInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
  disposition: AcceptedInputDisposition,
): boolean {
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind === "duplicate") return true;
  if (admission.kind === "full") return false;
  if (admission.kind === "reserved") {
    commitInputDisposition(runtime, admission.reservation, disposition);
  }
  return true;
}

/** A discarded queued input is no longer accepted; its stable-ID retry may restore it. */
export function forgetQueuedInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): void {
  if (!identity) return;
  const ledger = runtime.listener.acceptedInputDispositionLedger;
  if (!ledger) return;
  const key = dispositionKey(runtime.key, identity);
  if (ledger.entries.get(key)?.disposition === "queued") {
    deleteCurrentEntry(ledger, key);
  }
}
