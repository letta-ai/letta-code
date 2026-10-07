import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import {
  acquireDurableFileLock,
  currentDurableLockOwner,
  type DurableLockOwner,
  durableLockOwnerIsAlive,
  fsyncDirectory,
} from "./durable-file-lock";
import { inputDispositionPersistentPath } from "./input-disposition-path";
import { getConversationRuntimeKey } from "./runtime";
import type {
  AcceptedInputDisposition,
  AcceptedInputDispositionEntry,
  AcceptedInputDispositionLedger,
  ConversationRuntime,
  DurableQueuedInput,
  InputDispositionReservation,
  InputIdentity,
  ListenerRuntime,
} from "./types";

export const ACCEPTED_INPUT_DISPOSITION_TTL_MS = 60 * 60 * 1000;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE = 4096;
export const MAX_ACCEPTED_INPUT_DISPOSITIONS = 65_536;
export const MAX_DURABLE_QUEUED_INPUT_BYTES = 1024 * 1024;
export const MAX_INPUT_DISPOSITION_STORE_BYTES = 64 * 1024 * 1024;
const LOCK_WAIT_MS = 2_000;

export function ordinaryInputIdentity(
  clientMessageId: string | undefined,
): InputIdentity | undefined {
  return clientMessageId ? { domain: "input", id: clientMessageId } : undefined;
}

export function teleportInputIdentity(teleportId: string): InputIdentity {
  return { domain: "teleport", id: teleportId };
}

export function dispositionKey(
  runtimeKey: string,
  identity: InputIdentity,
): string {
  return JSON.stringify([runtimeKey, identity.domain, identity.id]);
}

function parseDispositionKey(
  key: string,
): [string, "input" | "teleport", string] {
  const parsed = JSON.parse(key) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    (parsed[1] !== "input" && parsed[1] !== "teleport") ||
    typeof parsed[2] !== "string" ||
    parsed[2].length === 0
  ) {
    throw new Error("Invalid accepted-input disposition key");
  }
  return parsed as [string, "input" | "teleport", string];
}

export { inputDispositionPersistentPath } from "./input-disposition-path";

function defaultPersistentPath(): string | null {
  if (process.env.NODE_ENV === "test") return null;
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  return inputDispositionPersistentPath(serverUrl);
}

export function createAcceptedInputDispositionLedger(options?: {
  persistentPath?: string | null;
}): AcceptedInputDispositionLedger {
  return {
    entries: new Map(),
    scopeCounts: new Map(),
    expiryQueue: [],
    expiryQueueHead: 0,
    nextGeneration: 0,
    abandonedReservations: new Map(),
    persistentPath:
      options && "persistentPath" in options
        ? (options.persistentPath ?? null)
        : defaultPersistentPath(),
  };
}

export function getLedger(
  listener: ListenerRuntime,
): AcceptedInputDispositionLedger {
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

export function deleteCurrentEntry(
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

function expireAcceptedInputDispositions(
  ledger: AcceptedInputDispositionLedger,
  now: number,
): void {
  while (ledger.expiryQueueHead < ledger.expiryQueue.length) {
    const expiry = ledger.expiryQueue[ledger.expiryQueueHead];
    if (!expiry || expiry.expiresAt > now) break;
    ledger.expiryQueueHead += 1;
    const entry = ledger.entries.get(expiry.key);
    if (
      entry?.generation === expiry.generation &&
      (entry.queuedInput || entry.preparedTerminal)
    ) {
      // Once accepted, replay responsibility lasts until a terminal transition
      // retires the payload. The sender retry horizon only bounds tombstones;
      // it must not erase in-flight work during a long turn or offline restart.
      entry.expiresAt = now + ACCEPTED_INPUT_DISPOSITION_TTL_MS;
      ledger.expiryQueue.push({
        key: expiry.key,
        expiresAt: entry.expiresAt,
        generation: entry.generation,
      });
    } else {
      deleteCurrentEntry(ledger, expiry.key, expiry.generation);
    }
  }
  if (
    ledger.expiryQueueHead >= 1024 &&
    ledger.expiryQueueHead * 2 >= ledger.expiryQueue.length
  ) {
    ledger.expiryQueue = ledger.expiryQueue.slice(ledger.expiryQueueHead);
    ledger.expiryQueueHead = 0;
  }
}

type ProcessOwner = DurableLockOwner;

type DurableReservation = ProcessOwner & {
  runtimeKey: string;
  generation: number;
};

export type DurableStore = {
  version: 4;
  nextGeneration: number;
  entries: Record<string, AcceptedInputDispositionEntry>;
  reservations: Record<string, DurableReservation>;
};

function emptyDurableStore(): DurableStore {
  return { version: 4, nextGeneration: 0, entries: {}, reservations: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateQueuedInput(value: unknown): value is DurableQueuedInput {
  if (!isRecord(value) || !isRecord(value.scope) || !isRecord(value.incoming)) {
    return false;
  }
  return (
    (typeof value.scope.agentId === "string" || value.scope.agentId === null) &&
    typeof value.scope.conversationId === "string" &&
    isRecord(value.identity) &&
    (value.identity.domain === "input" ||
      value.identity.domain === "teleport") &&
    typeof value.identity.id === "string" &&
    value.identity.id.length > 0 &&
    value.incoming.type === "message" &&
    Array.isArray(value.incoming.messages) &&
    (value.actingUserId === undefined || typeof value.actingUserId === "string")
  );
}

function validateDurableStore(value: unknown): DurableStore {
  if (
    !isRecord(value) ||
    (value.version !== 2 && value.version !== 3 && value.version !== 4) ||
    !Number.isSafeInteger(value.nextGeneration) ||
    (value.nextGeneration as number) < 0 ||
    !isRecord(value.entries) ||
    !isRecord(value.reservations)
  ) {
    throw new Error("Invalid accepted-input disposition store");
  }
  for (const [key, rawEntry] of Object.entries(value.entries)) {
    const [runtimeKey, domain, identityId] = parseDispositionKey(key);
    if (
      !isRecord(rawEntry) ||
      (rawEntry.disposition !== "started" &&
        rawEntry.disposition !== "queued") ||
      typeof rawEntry.acceptedAt !== "number" ||
      typeof rawEntry.expiresAt !== "number" ||
      rawEntry.runtimeKey !== runtimeKey ||
      !Number.isSafeInteger(rawEntry.generation)
    ) {
      throw new Error("Invalid accepted-input disposition entry");
    }
    // v2 lacked namespaces and wrote payload-free started tombstones. Upgrade in
    // memory; v4 writes must carry replay data or a completion marker.
    if (value.version === 2) {
      if (
        rawEntry.queuedInput !== undefined &&
        isRecord(rawEntry.queuedInput)
      ) {
        if (domain !== "input") {
          throw new Error(
            "Legacy replay payload has an invalid identity domain",
          );
        }
        rawEntry.queuedInput.identity = { domain, id: identityId };
        if (isRecord(rawEntry.queuedInput.incoming)) {
          rawEntry.queuedInput.incoming.durableInputIdentities = [
            { domain, id: identityId },
          ];
        }
      } else if (rawEntry.disposition === "started") {
        rawEntry.replayCompleted = true;
      }
    }
    if (rawEntry.queuedInput !== undefined) {
      if (!validateQueuedInput(rawEntry.queuedInput)) {
        throw new Error("Disposition replay payload is invalid");
      }
      const replayInput = rawEntry.queuedInput;
      if (
        getConversationRuntimeKey(
          replayInput.scope.agentId,
          replayInput.scope.conversationId,
        ) !== runtimeKey ||
        getConversationRuntimeKey(
          replayInput.incoming.agentId,
          replayInput.incoming.conversationId,
        ) !== runtimeKey ||
        replayInput.identity.domain !== domain ||
        replayInput.identity.id !== identityId ||
        dispositionKey(runtimeKey, replayInput.identity) !== key ||
        Buffer.byteLength(JSON.stringify(replayInput)) >
          MAX_DURABLE_QUEUED_INPUT_BYTES
      ) {
        throw new Error("Disposition replay payload identity is invalid");
      }
    } else if (rawEntry.replayCompleted !== true) {
      throw new Error(
        "Disposition is missing replay payload or terminal marker",
      );
    }
    if (
      rawEntry.queuedInput !== undefined &&
      rawEntry.replayCompleted !== undefined
    ) {
      throw new Error("Disposition cannot be both replayable and completed");
    }
    if (rawEntry.preparedTerminal !== undefined) {
      const prepared = rawEntry.preparedTerminal;
      if (
        !isRecord(prepared) ||
        (prepared.preparedAt !== undefined &&
          (typeof prepared.preparedAt !== "number" ||
            !Number.isFinite(prepared.preparedAt))) ||
        (prepared.preparationSequence !== undefined &&
          (!Number.isSafeInteger(prepared.preparationSequence) ||
            (prepared.preparationSequence as number) < 0)) ||
        (prepared.legacyAuthorityAmbiguous !== undefined &&
          typeof prepared.legacyAuthorityAmbiguous !== "boolean") ||
        !isRecord(prepared.scope) ||
        (prepared.scope.agentId !== null &&
          typeof prepared.scope.agentId !== "string") ||
        typeof prepared.scope.conversationId !== "string" ||
        getConversationRuntimeKey(
          prepared.scope.agentId,
          prepared.scope.conversationId,
        ) !== runtimeKey ||
        !isRecord(prepared.message) ||
        prepared.message.type !== "turn_finished" ||
        typeof prepared.message.turn_id !== "string" ||
        typeof prepared.message.stop_reason !== "string" ||
        (prepared.message.terminal_consumer_ids !== undefined &&
          (!Array.isArray(prepared.message.terminal_consumer_ids) ||
            !prepared.message.terminal_consumer_ids.every(
              (id) => typeof id === "string",
            ))) ||
        (prepared.message.run_id !== undefined &&
          typeof prepared.message.run_id !== "string") ||
        (prepared.message.error !== undefined &&
          typeof prepared.message.error !== "string") ||
        !isRecord(prepared.owner) ||
        (prepared.owner.connectionId !== null &&
          typeof prepared.owner.connectionId !== "string") ||
        typeof prepared.owner.canRotate !== "boolean" ||
        (prepared.owner.lineageId !== null &&
          typeof prepared.owner.lineageId !== "string") ||
        (prepared.owner.terminalIdentity !== undefined &&
          typeof prepared.owner.terminalIdentity !== "string") ||
        (prepared.owner.interruptedRevision !== undefined &&
          typeof prepared.owner.interruptedRevision !== "string") ||
        (prepared.owner.recoveryLineageId !== undefined &&
          typeof prepared.owner.recoveryLineageId !== "string") ||
        (prepared.owner.interruptedAuthorityRevision !== undefined &&
          typeof prepared.owner.interruptedAuthorityRevision !== "string") ||
        (prepared.owner.preparationSequence !== undefined &&
          (!Number.isSafeInteger(prepared.owner.preparationSequence) ||
            (prepared.owner.preparationSequence as number) < 0)) ||
        rawEntry.queuedInput !== undefined ||
        rawEntry.replayCompleted !== true
      ) {
        throw new Error("Prepared input terminal is invalid");
      }
    }
    if (
      rawEntry.completedTerminalRevision !== undefined &&
      typeof rawEntry.completedTerminalRevision !== "string"
    ) {
      throw new Error("Completed terminal revision is invalid");
    }
    const authority = rawEntry.completedTerminalAuthority;
    if (
      authority !== undefined &&
      (!isRecord(authority) ||
        typeof authority.interruptedRevision !== "string" ||
        typeof authority.authorityRevision !== "string" ||
        (authority.recoveryLineageId !== undefined &&
          typeof authority.recoveryLineageId !== "string") ||
        (authority.terminalIdentity !== undefined &&
          typeof authority.terminalIdentity !== "string") ||
        (authority.preparationSequence !== undefined &&
          (!Number.isSafeInteger(authority.preparationSequence) ||
            (authority.preparationSequence as number) < 0)))
    ) {
      throw new Error("Completed terminal authority is invalid");
    }
  }
  for (const [key, rawReservation] of Object.entries(value.reservations)) {
    const [runtimeKey] = parseDispositionKey(key);
    if (
      !isRecord(rawReservation) ||
      rawReservation.runtimeKey !== runtimeKey ||
      !Number.isSafeInteger(rawReservation.generation) ||
      typeof rawReservation.token !== "string" ||
      !Number.isSafeInteger(rawReservation.pid) ||
      (rawReservation.pid as number) <= 0 ||
      (rawReservation.processStart !== null &&
        typeof rawReservation.processStart !== "string")
    ) {
      throw new Error("Invalid accepted-input disposition reservation");
    }
  }
  value.version = 4;
  return value as DurableStore;
}

function readDurableStore(path: string): DurableStore {
  if (!existsSync(path)) return emptyDurableStore();
  const size = statSync(path).size;
  if (size > MAX_INPUT_DISPOSITION_STORE_BYTES) {
    throw new Error("Accepted-input disposition store exceeds its size limit");
  }
  return validateDurableStore(JSON.parse(readFileSync(path, "utf8")));
}

function prepareStateDirectory(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function writeDurableStore(path: string, store: DurableStore): void {
  prepareStateDirectory(path);
  const serialized = JSON.stringify(store);
  if (Buffer.byteLength(serialized) > MAX_INPUT_DISPOSITION_STORE_BYTES) {
    throw new Error("Accepted-input disposition store exceeds its size limit");
  }
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { mode: 0o600, flag: "wx" });
    // FlushFileBuffers rejects read-only handles on Windows.
    const fd = openSync(temporaryPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
      fsyncDirectory(dirname(path));
    } catch {}
    throw error;
  }
}

function currentProcessOwner(): ProcessOwner {
  return currentDurableLockOwner();
}

function isOwnerAlive(owner: ProcessOwner): boolean {
  return durableLockOwnerIsAlive(owner);
}

function acquireLock(path: string, waitMs = LOCK_WAIT_MS): () => void {
  prepareStateDirectory(path);
  return acquireDurableFileLock(path, { waitMs });
}

function pruneDurableStore(store: DurableStore, now: number): boolean {
  let changed = false;
  for (const [key, entry] of Object.entries(store.entries)) {
    if (entry.expiresAt <= now) {
      if (entry.queuedInput || entry.preparedTerminal) {
        entry.expiresAt = now + ACCEPTED_INPUT_DISPOSITION_TTL_MS;
      } else {
        delete store.entries[key];
      }
      changed = true;
    }
  }
  for (const [key, reservation] of Object.entries(store.reservations)) {
    if (!isOwnerAlive(reservation)) {
      delete store.reservations[key];
      changed = true;
    }
  }
  return changed;
}

export function durableTransaction<T>(
  path: string,
  transaction: (store: DurableStore) => { result: T; changed: boolean },
): T {
  const release = acquireLock(path);
  try {
    const store = readDurableStore(path);
    const pruned = pruneDurableStore(store, Date.now());
    const { result, changed } = transaction(store);
    if (pruned || changed) writeDurableStore(path, store);
    return result;
  } finally {
    release();
  }
}

export function syncMemoryFromDurable(
  ledger: AcceptedInputDispositionLedger,
  store: DurableStore,
): void {
  ledger.entries.clear();
  ledger.scopeCounts.clear();
  ledger.expiryQueue = [];
  ledger.expiryQueueHead = 0;
  ledger.nextGeneration = store.nextGeneration;
  for (const [key, abandoned] of ledger.abandonedReservations) {
    const reservation = store.reservations[key];
    if (
      !reservation ||
      reservation.token !== abandoned.token ||
      reservation.generation !== abandoned.generation
    ) {
      ledger.abandonedReservations.delete(key);
    }
  }
  for (const [key, entry] of Object.entries(store.entries)) {
    ledger.entries.set(key, { ...entry });
    ledger.scopeCounts.set(
      entry.runtimeKey,
      (ledger.scopeCounts.get(entry.runtimeKey) ?? 0) + 1,
    );
    ledger.expiryQueue.push({
      key,
      expiresAt: entry.expiresAt,
      generation: entry.generation,
    });
  }
  ledger.expiryQueue.sort((left, right) => left.expiresAt - right.expiresAt);
}

export type InputDispositionAdmission =
  | { kind: "untracked" }
  | { kind: "duplicate"; disposition: AcceptedInputDisposition }
  | { kind: "reserved"; reservation: InputDispositionReservation }
  | { kind: "full" };

function reserveDurably(
  ledger: AcceptedInputDispositionLedger,
  runtimeKey: string,
  key: string,
): InputDispositionAdmission {
  const path = ledger.persistentPath;
  if (!path) return { kind: "full" };
  try {
    const result = durableTransaction<InputDispositionAdmission>(
      path,
      (store) => {
        syncMemoryFromDurable(ledger, store);
        const existing = store.entries[key];
        if (existing) {
          if (!existing.disposition) {
            throw new Error("Durable disposition entry is uncommitted");
          }
          return {
            result: { kind: "duplicate", disposition: existing.disposition },
            changed: false,
          };
        }
        const heldReservation = store.reservations[key];
        const abandoned = ledger.abandonedReservations.get(key);
        if (
          heldReservation &&
          abandoned &&
          heldReservation.generation === abandoned.generation &&
          heldReservation.token === abandoned.token
        ) {
          delete store.reservations[key];
        } else if (heldReservation) {
          return { result: { kind: "full" }, changed: false };
        }
        const scopeCount = Object.values(store.entries).filter(
          (entry) => entry.runtimeKey === runtimeKey,
        ).length;
        const reservedScopeCount = Object.values(store.reservations).filter(
          (entry) => entry.runtimeKey === runtimeKey,
        ).length;
        if (
          Object.keys(store.entries).length +
            Object.keys(store.reservations).length >=
            MAX_ACCEPTED_INPUT_DISPOSITIONS ||
          scopeCount + reservedScopeCount >=
            MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE
        ) {
          return { result: { kind: "full" }, changed: false };
        }
        const generation = ++store.nextGeneration;
        const owner = currentProcessOwner();
        store.reservations[key] = { runtimeKey, generation, ...owner };
        ledger.nextGeneration = generation;
        return {
          result: {
            kind: "reserved",
            reservation: {
              key,
              generation,
              runtimeKey,
              token: owner.token,
              ownerPid: owner.pid,
              ownerProcessStart: owner.processStart,
            },
          },
          changed: true,
        };
      },
    );
    if (result.kind === "reserved") ledger.abandonedReservations.delete(key);
    return result;
  } catch {
    return { kind: "full" };
  }
}

export function reserveInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): InputDispositionAdmission {
  if (!identity) return { kind: "untracked" };
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, identity);
  if (ledger.persistentPath) return reserveDurably(ledger, runtime.key, key);

  const now = Date.now();
  expireAcceptedInputDispositions(ledger, now);
  const existing = ledger.entries.get(key);
  if (existing) {
    if (existing.disposition) {
      return { kind: "duplicate", disposition: existing.disposition };
    }
    return { kind: "full" };
  }
  if (
    ledger.entries.size >= MAX_ACCEPTED_INPUT_DISPOSITIONS ||
    (ledger.scopeCounts.get(runtime.key) ?? 0) >=
      MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE
  ) {
    return { kind: "full" };
  }
  const generation = ++ledger.nextGeneration;
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

function serializeQueuedInput(
  runtime: ConversationRuntime,
  identity: InputIdentity,
  queuedInput: Omit<DurableQueuedInput, "scope" | "identity"> | undefined,
): DurableQueuedInput | undefined {
  if (!queuedInput) return undefined;
  const payload: DurableQueuedInput = {
    scope: {
      agentId: runtime.agentId,
      conversationId: runtime.conversationId,
    },
    identity,
    incoming: { ...queuedInput.incoming, durableInputIdentities: [identity] },
    ...(queuedInput.actingUserId
      ? { actingUserId: queuedInput.actingUserId }
      : {}),
  };
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_DURABLE_QUEUED_INPUT_BYTES) {
    throw new Error("Queued input exceeds its durable size limit");
  }
  return JSON.parse(serialized) as DurableQueuedInput;
}

export function commitInputDisposition(
  runtime: ConversationRuntime,
  reservation: InputDispositionReservation | undefined,
  disposition: AcceptedInputDisposition,
  queuedInput?: Omit<DurableQueuedInput, "scope" | "identity">,
): boolean {
  if (!reservation) {
    // A queued acknowledgement is final to Cloud. Without a stable identity it
    // cannot be represented in the durable store or restored exactly once.
    return !(
      disposition === "queued" && getLedger(runtime.listener).persistentPath
    );
  }
  const ledger = getLedger(runtime.listener);
  let durableQueuedInput: DurableQueuedInput | undefined;
  try {
    const [, domain, id] = parseDispositionKey(reservation.key);
    durableQueuedInput = serializeQueuedInput(
      runtime,
      { domain, id },
      queuedInput,
    );
  } catch {
    return false;
  }
  if (!durableQueuedInput && ledger.persistentPath) {
    return false;
  }
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        const held = store.reservations[reservation.key];
        if (
          !held ||
          held.token !== reservation.token ||
          held.generation !== reservation.generation ||
          held.runtimeKey !== runtime.key
        ) {
          syncMemoryFromDurable(ledger, store);
          return { result: false, changed: false };
        }
        const acceptedAt = Date.now();
        store.entries[reservation.key] = {
          disposition,
          acceptedAt,
          expiresAt: acceptedAt + ACCEPTED_INPUT_DISPOSITION_TTL_MS,
          runtimeKey: runtime.key,
          generation: held.generation,
          ...(durableQueuedInput ? { queuedInput: durableQueuedInput } : {}),
        };
        delete store.reservations[reservation.key];
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed: true };
      });
    } catch {
      return false;
    }
  }

  const entry = ledger.entries.get(reservation.key);
  if (
    entry?.generation !== reservation.generation ||
    entry.runtimeKey !== runtime.key
  ) {
    return false;
  }
  if (entry.disposition) return true;
  const acceptedAt = Date.now();
  entry.acceptedAt = acceptedAt;
  entry.expiresAt = acceptedAt + ACCEPTED_INPUT_DISPOSITION_TTL_MS;
  entry.disposition = disposition;
  if (durableQueuedInput) entry.queuedInput = durableQueuedInput;
  ledger.expiryQueue.push({
    key: reservation.key,
    expiresAt: entry.expiresAt,
    generation: entry.generation,
  });
  return true;
}

export function getInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): AcceptedInputDisposition | undefined {
  if (!identity) return undefined;
  const ledger = getLedger(runtime.listener);
  const key = dispositionKey(runtime.key, identity);
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        syncMemoryFromDurable(ledger, store);
        return {
          result: store.entries[key]?.disposition ?? undefined,
          changed: false,
        };
      });
    } catch {
      return undefined;
    }
  }
  expireAcceptedInputDispositions(ledger, Date.now());
  return ledger.entries.get(key)?.disposition ?? undefined;
}

export function rememberInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
  disposition: AcceptedInputDisposition,
  queuedInput?: Omit<DurableQueuedInput, "scope" | "identity">,
): boolean {
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind === "duplicate") return true;
  if (admission.kind === "full") return false;
  if (admission.kind === "reserved") {
    return commitInputDisposition(
      runtime,
      admission.reservation,
      disposition,
      queuedInput,
    );
  }
  return true;
}

export function forgetQueuedInputDisposition(
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): boolean {
  return forgetQueuedInputDispositions(runtime, identity ? [identity] : []);
}

/** Atomically discard a queue mutation's complete set of durable payloads. */
export function forgetQueuedInputDispositions(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
): boolean {
  if (identities.length === 0) return true;
  const ledger = runtime.listener.acceptedInputDispositionLedger;
  if (!ledger) return true;
  const keys = [
    ...new Set(
      identities.map((identity) => dispositionKey(runtime.key, identity)),
    ),
  ];
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        for (const key of keys) {
          const entry = store.entries[key];
          if (
            entry &&
            entry.disposition !== "queued" &&
            !(entry.disposition === "started" && entry.queuedInput)
          ) {
            syncMemoryFromDurable(ledger, store);
            return { result: false, changed: false };
          }
        }
        let changed = false;
        for (const key of keys) {
          if (store.entries[key]) {
            delete store.entries[key];
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
    if (
      entry?.disposition === "queued" ||
      (entry?.disposition === "started" && entry.queuedInput)
    ) {
      deleteCurrentEntry(ledger, key);
    }
  }
  return true;
}

/** Atomically transition queued dispositions while retaining crash-replay payloads. */
export function markQueuedInputDispositionsStarted(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
): boolean {
  if (identities.length === 0) return true;
  const ledger = getLedger(runtime.listener);
  const keys = [
    ...new Set(
      identities.map((identity) => dispositionKey(runtime.key, identity)),
    ),
  ];
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        const queuedKeys = keys.filter(
          (key) => store.entries[key]?.disposition === "queued",
        );
        if (
          queuedKeys.some(
            (key) => store.entries[key]?.queuedInput === undefined,
          )
        ) {
          syncMemoryFromDurable(ledger, store);
          return { result: false, changed: false };
        }
        for (const key of queuedKeys) {
          const entry = store.entries[key];
          if (!entry) throw new Error("Queued disposition vanished");
          entry.disposition = "started";
        }
        syncMemoryFromDurable(ledger, store);
        return { result: true, changed: queuedKeys.length > 0 };
      });
    } catch {
      return false;
    }
  }
  for (const key of keys) {
    const entry = ledger.entries.get(key);
    if (entry?.disposition === "queued") entry.disposition = "started";
  }
  return true;
}

/** Return a destructively dequeued input to durable queued ownership. */
export function requeueStartedInputDispositions(
  runtime: ConversationRuntime,
  identities: readonly InputIdentity[],
): boolean {
  if (identities.length === 0) return true;
  const ledger = getLedger(runtime.listener);
  const keys = [
    ...new Set(
      identities.map((identity) => dispositionKey(runtime.key, identity)),
    ),
  ];
  if (ledger.persistentPath) {
    try {
      return durableTransaction(ledger.persistentPath, (store) => {
        let changed = false;
        for (const key of keys) {
          const entry = store.entries[key];
          if (!entry?.queuedInput) {
            syncMemoryFromDurable(ledger, store);
            return { result: false, changed: false };
          }
          if (entry.disposition === "started") {
            entry.disposition = "queued";
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
    if (!entry?.queuedInput) return false;
    if (entry.disposition === "started") entry.disposition = "queued";
  }
  return true;
}

/** Read every replay payload under the store lock for startup restore. */
export function loadDurableQueuedInputs(
  listener: ListenerRuntime,
): DurableQueuedInput[] {
  const ledger = getLedger(listener);
  if (!ledger.persistentPath) return [];
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return {
      result: Object.values(store.entries).flatMap((entry) =>
        entry.queuedInput ? [structuredClone(entry.queuedInput)] : [],
      ),
      changed: false,
    };
  });
}

export function loadDurableQueuedInputEntries(
  listener: ListenerRuntime,
): Array<{
  disposition: AcceptedInputDisposition;
  payload: DurableQueuedInput;
}> {
  const ledger = getLedger(listener);
  const collect = (entries: Iterable<AcceptedInputDispositionEntry>) =>
    [...entries].flatMap((entry) =>
      entry.queuedInput && entry.disposition
        ? [
            {
              disposition: entry.disposition,
              payload: structuredClone(entry.queuedInput),
            },
          ]
        : [],
    );
  if (!ledger.persistentPath) return collect(ledger.entries.values());
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return {
      result: collect(Object.values(store.entries)),
      changed: false,
    };
  });
}

export const __inputDispositionTestUtils = {
  acquireLock,
  currentProcessOwner,
};
