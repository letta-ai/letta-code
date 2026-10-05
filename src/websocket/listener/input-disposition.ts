import type {
  AcceptedInputDisposition,
  AcceptedInputDispositionLedger,
  ConversationRuntime,
  InputDispositionReservation,
  ListenerRuntime,
} from "./types";

/** Cover Cloud's five ten-minute delivery attempts plus bounded retry backoff. */
export const ACCEPTED_INPUT_DISPOSITION_TTL_MS = 60 * 60 * 1000;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE = 4096;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS = 65_536;

function dispositionKey(runtimeKey: string, clientMessageId: string): string {
  return JSON.stringify([runtimeKey, clientMessageId]);
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
  clientMessageId: string | undefined,
): InputDispositionAdmission {
  if (!clientMessageId) return { kind: "untracked" };
  const ledger = getLedger(runtime.listener);
  const now = Date.now();
  expireAcceptedInputDispositions(ledger, now);
  const key = dispositionKey(runtime.key, clientMessageId);
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

export function rollbackInputDisposition(
  runtime: ConversationRuntime,
  reservation: InputDispositionReservation | undefined,
): void {
  if (!reservation) return;
  deleteCurrentEntry(
    getLedger(runtime.listener),
    reservation.key,
    reservation.generation,
  );
}

export function getInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
): AcceptedInputDisposition | undefined {
  if (!clientMessageId) return undefined;
  const ledger = getLedger(runtime.listener);
  expireAcceptedInputDispositions(ledger, Date.now());
  return (
    ledger.entries.get(dispositionKey(runtime.key, clientMessageId))
      ?.disposition ?? undefined
  );
}

/** Test/setup helper; production ingress should use reserve/commit/rollback. */
export function rememberInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
  disposition: AcceptedInputDisposition,
): boolean {
  const admission = reserveInputDisposition(runtime, clientMessageId);
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
  clientMessageId: string | undefined,
): void {
  if (!clientMessageId) return;
  const ledger = runtime.listener.acceptedInputDispositionLedger;
  if (!ledger) return;
  const key = dispositionKey(runtime.key, clientMessageId);
  if (ledger.entries.get(key)?.disposition === "queued") {
    deleteCurrentEntry(ledger, key);
  }
}
