import type {
  AcceptedInputDisposition,
  ConversationRuntime,
  ListenerRuntime,
} from "./types";

/** Cover Cloud's five ten-minute delivery attempts plus bounded retry backoff. */
export const ACCEPTED_INPUT_DISPOSITION_TTL_MS = 60 * 60 * 1000;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE = 4096;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS = 65_536;

function dispositionKey(runtimeKey: string, clientMessageId: string): string {
  return JSON.stringify([runtimeKey, clientMessageId]);
}

function getLedger(listener: ListenerRuntime) {
  if (!listener.acceptedInputDispositions) {
    listener.acceptedInputDispositions = new Map();
  }
  return listener.acceptedInputDispositions;
}

function pruneAcceptedInputDispositions(
  listener: ListenerRuntime,
  now: number,
): void {
  const ledger = getLedger(listener);
  for (const [key, entry] of ledger) {
    if (now - entry.acceptedAt >= ACCEPTED_INPUT_DISPOSITION_TTL_MS) {
      ledger.delete(key);
    }
  }
  while (ledger.size > MAX_ACCEPTED_INPUT_DISPOSITIONS) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

function pruneAcceptedInputDispositionsForScope(
  listener: ListenerRuntime,
  runtimeKey: string,
): void {
  const ledger = getLedger(listener);
  let scopeSize = 0;
  for (const entry of ledger.values()) {
    if (entry.runtimeKey === runtimeKey) scopeSize += 1;
  }
  if (scopeSize <= MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE) return;
  for (const [key, entry] of ledger) {
    if (entry.runtimeKey !== runtimeKey) continue;
    ledger.delete(key);
    scopeSize -= 1;
    if (scopeSize <= MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE) return;
  }
}

export function getInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
): AcceptedInputDisposition | undefined {
  if (!clientMessageId) return undefined;
  const now = Date.now();
  pruneAcceptedInputDispositions(runtime.listener, now);
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, clientMessageId);
  const entry = ledger.get(key);
  if (!entry) return undefined;
  ledger.delete(key);
  ledger.set(key, entry);
  return entry.disposition;
}

export function rememberInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
  disposition: AcceptedInputDisposition,
): void {
  if (!clientMessageId) return;
  const now = Date.now();
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, clientMessageId);
  ledger.delete(key);
  ledger.set(key, { disposition, acceptedAt: now, runtimeKey: runtime.key });
  pruneAcceptedInputDispositionsForScope(runtime.listener, runtime.key);
  pruneAcceptedInputDispositions(runtime.listener, now);
}

/** A discarded queued input is no longer accepted; its stable-ID retry may restore it. */
export function forgetQueuedInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
): void {
  if (!clientMessageId) return;
  const ledger = runtime.listener.acceptedInputDispositions;
  if (!ledger) return;
  const key = dispositionKey(runtime.key, clientMessageId);
  if (ledger.get(key)?.disposition === "queued") {
    ledger.delete(key);
  }
}
