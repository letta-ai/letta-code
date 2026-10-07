import { randomUUID } from "node:crypto";
import {
  closeSync,
  type Dirent,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import type { TurnFinishedMessage } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { toListenerConnection } from "./connection";
import { acquireDurableFileLock } from "./durable-file-lock";
import { createInterruptedTurnStore } from "./interrupted-turn-record";
import {
  emitProtocolV2Message,
  type OutboundMessageDelivery,
} from "./protocol-outbound";
import { getConversationRuntimeKey } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime } from "./types";

export type ReplayableTurnFinished = Omit<
  TurnFinishedMessage,
  "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
>;

export type TurnFinishedOwner = {
  /** Exact connection which owned the turn. Null denotes process-owned work. */
  connectionId: string | null;
  /** Only rotating clients may hand terminal ownership to another subscriber. */
  canRotate: boolean;
  /** Explicit startup lineage, retained for same-lineage replacement checks. */
  lineageId: string | null;
  terminalIdentity?: string;
  /** Exact interrupted-work revision superseded by this terminal. */
  interruptedRevision?: string;
  /** Independent recovery lineage whose mutable authority was observed. */
  recoveryLineageId?: string;
  /** Exact mutable main/sidecar generation validated by this terminal. */
  interruptedAuthorityRevision?: string;
};

export class TurnFinishedCapacityError extends Error {
  constructor() {
    super("Pending turn-finished durability capacity exceeded");
    this.name = "TurnFinishedCapacityError";
  }
}

function terminalAuthorityStatus(
  runtime: ConversationRuntime,
  terminal: PersistedTurnFinished,
): "current" | "stale" | "unknown" {
  const { owner } = terminal;
  if (!owner.recoveryLineageId) return "current";
  if (
    !runtime.agentId ||
    !owner.interruptedRevision ||
    !owner.interruptedAuthorityRevision
  ) {
    return "stale";
  }
  try {
    const snapshot = createInterruptedTurnStore().readRecoverySnapshot(
      runtime.agentId,
      runtime.conversationId,
      owner.recoveryLineageId,
    );
    if (!snapshot) return "current";
    if (
      snapshot.record.revision === owner.interruptedRevision &&
      snapshot.revisionToken === owner.interruptedAuthorityRevision
    ) {
      return "current";
    }
    return snapshot.record.recoveryClaimCompletion?.state === "pending"
      ? "unknown"
      : "stale";
  } catch {
    return "unknown";
  }
}

type DeliveryClaim = {
  token: string;
  pid: number;
  connectionId: string;
  claimedAt: number;
};

export type PersistedTurnFinished = {
  /** Stable application-level idempotency identity, reused for every replay. */
  id: string;
  createdAt: number;
  message: ReplayableTurnFinished;
  owner: TurnFinishedOwner;
  requiredConsumerIds: string[];
  acknowledgedConsumerIds: string[];
  claim?: DeliveryClaim;
};

export type PersistedTurnFinishedRecord = {
  agentId: string | null;
  conversationId: string;
  terminals: PersistedTurnFinished[];
};

const MAX_PENDING_TERMINALS_PER_CONVERSATION = 64;
const DELIVERY_CLAIM_MS = 30_000;
/**
 * Sender replay lifetime, matched to Cloud's completion-identity dedupe retention.
 * Cloud's 24-hour receiver retention must deploy before this sender horizon.
 */
export const TURN_FINISHED_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

function defaultDirectory(): string {
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    // Startup state replay can run before settings initialization (notably the
    // local App Server). Keep that namespace deterministic rather than failing
    // connection initialization.
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  return join(
    homedir(),
    ".letta",
    "listener-terminal-state",
    Buffer.from(serverUrl).toString("base64url"),
  );
}

/** A reversible tuple encoding; unlike delimiter-based names it cannot alias. */
export function encodeTurnFinishedScope(
  agentId: string | null,
  conversationId: string,
): string {
  return Buffer.from(JSON.stringify([agentId, conversationId])).toString(
    "base64url",
  );
}

function decodeTurnFinishedScope(
  encoded: string,
): [agentId: string | null, conversationId: string] | null {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      (value[0] !== null && typeof value[0] !== "string") ||
      typeof value[1] !== "string" ||
      encodeTurnFinishedScope(value[0], value[1]) !== encoded
    ) {
      return null;
    }
    return [value[0], value[1]];
  } catch {
    return null;
  }
}

function fsyncDirectory(directory: string): void {
  // Windows has no fsync-able directory handle. File data is still flushed by
  // writeFileSync(..., { flush: true }); POSIX keeps the rename/unlink barrier.
  if (process.platform === "win32") return;
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createTurnFinishedStore(
  directory = defaultDirectory(),
  options: { lockAttempts?: number } = {},
) {
  const claimantToken = randomUUID();
  const path = (agentId: string | null, conversationId: string) =>
    join(directory, `${encodeTurnFinishedScope(agentId, conversationId)}.json`);
  const readRecord = (
    agentId: string | null,
    conversationId: string,
  ): PersistedTurnFinishedRecord | null => {
    try {
      const record = JSON.parse(
        readFileSync(path(agentId, conversationId), "utf8"),
      ) as PersistedTurnFinishedRecord;
      if (
        record.agentId !== agentId ||
        record.conversationId !== conversationId ||
        !Array.isArray(record.terminals) ||
        !record.terminals.every(
          (terminal) =>
            typeof terminal.id === "string" &&
            Number.isFinite(terminal.createdAt) &&
            terminal.message?.type === "turn_finished" &&
            typeof terminal.message.turn_id === "string" &&
            Array.isArray(terminal.requiredConsumerIds) &&
            terminal.requiredConsumerIds.every(
              (id) => typeof id === "string",
            ) &&
            Array.isArray(terminal.acknowledgedConsumerIds) &&
            terminal.acknowledgedConsumerIds.every(
              (id) => typeof id === "string",
            ) &&
            !!terminal.owner &&
            (terminal.owner.connectionId === null ||
              typeof terminal.owner.connectionId === "string") &&
            typeof terminal.owner.canRotate === "boolean" &&
            (terminal.owner.terminalIdentity === undefined ||
              typeof terminal.owner.terminalIdentity === "string") &&
            (terminal.owner.interruptedRevision === undefined ||
              typeof terminal.owner.interruptedRevision === "string") &&
            (terminal.owner.recoveryLineageId === undefined ||
              typeof terminal.owner.recoveryLineageId === "string") &&
            (terminal.owner.interruptedAuthorityRevision === undefined ||
              typeof terminal.owner.interruptedAuthorityRevision === "string"),
        )
      ) {
        throw new Error("Invalid turn-finished record");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const write = (record: PersistedTurnFinishedRecord): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const destination = path(record.agentId, record.conversationId);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), {
        mode: 0o600,
        flush: true,
      });
      renameSync(temporary, destination);
      fsyncDirectory(directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const removeRecordFile = (recordPath: string): void => {
    rmSync(recordPath, { force: true });
    fsyncDirectory(directory);
  };
  const withRecordLock = <T>(
    agentId: string | null,
    conversationId: string,
    operation: () => T,
  ): T => {
    const release = acquireDurableFileLock(path(agentId, conversationId), {
      waitMs: (options.lockAttempts ?? 500) * 10,
    });
    try {
      return operation();
    } finally {
      release();
    }
  };
  const readPrunedRecord = (
    agentId: string | null,
    conversationId: string,
  ): PersistedTurnFinishedRecord | null => {
    const record = readRecord(agentId, conversationId);
    if (!record) return null;
    const now = Date.now();
    const retained = record.terminals.filter(
      (terminal) => now - terminal.createdAt < TURN_FINISHED_REPLAY_TTL_MS,
    );
    if (retained.length === record.terminals.length) return record;
    record.terminals = retained;
    if (retained.length === 0) removeRecordFile(path(agentId, conversationId));
    else write(record);
    return retained.length === 0 ? null : record;
  };
  const read = (
    agentId: string | null,
    conversationId: string,
  ): PersistedTurnFinishedRecord | null => {
    try {
      return withRecordLock(agentId, conversationId, () =>
        readPrunedRecord(agentId, conversationId),
      );
    } catch (error) {
      debugWarn("recovery", "Ignoring unreadable turn-finished record", error);
      return null;
    }
  };
  const sweepExpiredRecords = (): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const scope = decodeTurnFinishedScope(entry.name.slice(0, -5));
      if (!scope) continue; // Unknown/corrupt names are never deleted.
      try {
        withRecordLock(scope[0], scope[1], () => {
          readPrunedRecord(scope[0], scope[1]);
        });
      } catch (error) {
        // A validated filename with corrupt/mismatched contents also fails
        // closed. Other scopes must still receive their exact-horizon sweep.
        debugWarn(
          "recovery",
          "Ignoring unreadable turn-finished record",
          error,
        );
      }
    }
  };

  // Sweep every reversible record namespace at construction, not merely scopes
  // whose runtimes happen to be recreated after an offline restart.
  sweepExpiredRecords();

  return {
    read,
    put(
      agentId: string | null,
      conversationId: string,
      message: ReplayableTurnFinished,
      owner: TurnFinishedOwner = {
        connectionId: null,
        canRotate: false,
        lineageId: null,
      },
    ): PersistedTurnFinished {
      return withRecordLock(agentId, conversationId, () => {
        const record = readPrunedRecord(agentId, conversationId) ?? {
          agentId,
          conversationId,
          terminals: [],
        };
        const existing = record.terminals.find((terminal) =>
          owner.terminalIdentity
            ? terminal.owner.terminalIdentity === owner.terminalIdentity
            : terminal.owner.terminalIdentity === undefined &&
              terminal.message.turn_id === message.turn_id,
        );
        if (existing) {
          if (
            JSON.stringify(existing.message) !== JSON.stringify(message) ||
            JSON.stringify(existing.owner) !== JSON.stringify(owner)
          ) {
            throw new Error("Turn-finished identity collision");
          }
          return existing;
        }
        if (record.terminals.length >= MAX_PENDING_TERMINALS_PER_CONVERSATION) {
          if (owner.connectionId === null) {
            const oldestProcessTerminal = record.terminals.findIndex(
              (terminal) => terminal.owner.connectionId === null,
            );
            if (oldestProcessTerminal >= 0) {
              record.terminals.splice(oldestProcessTerminal, 1);
            } else {
              throw new TurnFinishedCapacityError();
            }
          } else {
            throw new TurnFinishedCapacityError();
          }
        }
        const terminal: PersistedTurnFinished = {
          id: `turn_finished:${randomUUID()}`,
          createdAt: Date.now(),
          message,
          owner,
          requiredConsumerIds: [
            ...new Set(message.terminal_consumer_ids ?? []),
          ],
          acknowledgedConsumerIds: [],
        };
        record.terminals.push(terminal);
        write(record);
        return terminal;
      });
    },
    claim(
      agentId: string | null,
      conversationId: string,
      id: string,
      connectionId: string,
    ): PersistedTurnFinished | null {
      return withRecordLock(agentId, conversationId, () => {
        const record = readPrunedRecord(agentId, conversationId);
        const terminal = record?.terminals.find(
          (candidate) => candidate.id === id,
        );
        if (!record || !terminal) return null;
        const claim = terminal.claim;
        if (claim && Date.now() - claim.claimedAt < DELIVERY_CLAIM_MS) {
          return null;
        }
        terminal.claim = {
          token: claimantToken,
          pid: process.pid,
          connectionId,
          claimedAt: Date.now(),
        };
        write(record);
        return terminal;
      });
    },
    releaseClaim(
      agentId: string | null,
      conversationId: string,
      id: string,
      connectionId: string,
    ): void {
      withRecordLock(agentId, conversationId, () => {
        const record = readPrunedRecord(agentId, conversationId);
        const terminal = record?.terminals.find(
          (candidate) => candidate.id === id,
        );
        if (
          !record ||
          !terminal ||
          terminal.claim?.token !== claimantToken ||
          terminal.claim.connectionId !== connectionId
        ) {
          return;
        }
        delete terminal.claim;
        write(record);
      });
    },
    acknowledge(
      agentId: string | null,
      conversationId: string,
      id: string,
      connectionId: string,
      consumerId: string,
    ): boolean {
      return withRecordLock(agentId, conversationId, () => {
        const record = readPrunedRecord(agentId, conversationId);
        if (!record) return false;
        const terminal = record.terminals.find(
          (candidate) => candidate.id === id,
        );
        if (
          !terminal ||
          terminal.claim?.connectionId !== connectionId ||
          !terminal.requiredConsumerIds.includes(consumerId)
        ) {
          return false;
        }
        if (!terminal.acknowledgedConsumerIds.includes(consumerId)) {
          terminal.acknowledgedConsumerIds.push(consumerId);
        }
        if (
          terminal.requiredConsumerIds.some(
            (required) => !terminal.acknowledgedConsumerIds.includes(required),
          )
        ) {
          write(record);
          return true;
        }
        record.terminals = record.terminals.filter(
          (candidate) => candidate.id !== id,
        );
        if (record.terminals.length === 0) {
          removeRecordFile(path(agentId, conversationId));
        } else {
          write(record);
        }
        return true;
      });
    },
    remove(agentId: string | null, conversationId: string, id: string): void {
      withRecordLock(agentId, conversationId, () => {
        const record = readPrunedRecord(agentId, conversationId);
        if (!record) return;
        record.terminals = record.terminals.filter(
          (terminal) => terminal.id !== id,
        );
        if (record.terminals.length === 0) {
          removeRecordFile(path(agentId, conversationId));
        } else {
          write(record);
        }
      });
    },
  };
}

const replayInFlight = new Set<string>();

export type PreparedTurnFinished =
  | {
      kind: "durable";
      store: ReturnType<typeof createTurnFinishedStore>;
      terminal: PersistedTurnFinished;
    }
  | { kind: "ephemeral" };

export function getTurnFinishedOwner(
  runtime: ConversationRuntime,
  interruptedRevision?: string,
): TurnFinishedOwner {
  // Only a connection which actually owns the turn may own its terminal.
  // A service-level listener connection is not provenance for cron/task work.
  const connectionId = runtime.activeConnectionId;
  const connection = connectionId
    ? runtime.listener.connections.get(connectionId)
    : undefined;
  return {
    connectionId,
    canRotate: connection?.options.connectionIdCanResume === false,
    lineageId: connection?.startupOwner.lineageId ?? null,
    terminalIdentity: randomUUID(),
    ...(interruptedRevision ? { interruptedRevision } : {}),
  };
}

/** Persist the authoritative terminal before its lease is finalized. */
export function prepareTurnFinished(
  runtime: ConversationRuntime,
  message: ReplayableTurnFinished,
  providedStore?: ReturnType<typeof createTurnFinishedStore>,
  providedOwner?: TurnFinishedOwner,
  persistWithoutConsumers = false,
): PreparedTurnFinished {
  const owner = providedOwner ?? getTurnFinishedOwner(runtime);
  // Process-owned work and rotating App Server clients have no peer that
  // implements the Cloud terminal acknowledgement contract. Keep those paths
  // explicitly ephemeral rather than accumulating records that can never be
  // retired. Tests may opt into bounded unattended persistence with a store.
  // Agent-free App Server scopes likewise have no Cloud application consumer;
  // their terminal is intentionally best-effort even on a stable connection.
  if (
    runtime.agentId === null ||
    (!persistWithoutConsumers &&
      (!message.terminal_consumer_ids?.length ||
        (!providedStore && (owner.connectionId === null || owner.canRotate))))
  ) {
    return { kind: "ephemeral" };
  }
  const store = providedStore ?? createTurnFinishedStore();
  return {
    kind: "durable",
    store,
    terminal: store.put(
      runtime.agentId,
      runtime.conversationId,
      message,
      owner,
    ),
  };
}

function isEligibleOwner(
  runtime: ConversationRuntime,
  terminal: PersistedTurnFinished,
  connectionId: string,
): boolean {
  const connection = runtime.listener.connections.get(connectionId);
  if (!connection?.initialized) return false;
  const runtimeKey = getConversationRuntimeKey(
    runtime.agentId,
    runtime.conversationId,
  );
  if (!connection.subscriptions.has(runtimeKey)) return false;
  if (terminal.owner.connectionId === connectionId) return true;
  if (
    terminal.owner.lineageId &&
    connection.startupOwner.lineageId === terminal.owner.lineageId
  ) {
    return true;
  }
  if (!terminal.owner.canRotate) return false;
  if (runtime.activeConnectionId === connectionId) return true;
  if (runtime.activeConnectionId !== null) return false;
  // Rotating App Server clients cannot preserve physical ids. The first scoped
  // subscriber after the previous owner disappears becomes the authoritative
  // replacement, matching live terminal handoff behavior.
  runtime.activeConnectionId = connectionId;
  return true;
}

function sendClaimedTerminal(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  connectionId: string,
  terminal: PersistedTurnFinished,
): OutboundMessageDelivery {
  return emitProtocolV2Message(
    socket,
    runtime,
    terminal.message,
    {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    },
    toListenerConnection(connectionId),
    true,
    { idempotencyKey: terminal.id },
  );
}

function observeDefiniteDrop(params: {
  delivery: OutboundMessageDelivery;
  store: ReturnType<typeof createTurnFinishedStore>;
  runtime: ConversationRuntime;
  terminal: PersistedTurnFinished;
  connectionId: string;
}): void {
  if (params.delivery.receipts.length === 0) {
    try {
      params.store.releaseClaim(
        params.runtime.agentId,
        params.runtime.conversationId,
        params.terminal.id,
        params.connectionId,
      );
    } catch (error) {
      debugWarn(
        "recovery",
        "Failed to release undelivered terminal claim",
        error,
      );
    }
    return;
  }
  void Promise.all(
    params.delivery.receipts.map((receipt) => receipt.settlement),
  )
    .then((settlements) => {
      if (settlements.every((settlement) => settlement === "dropped")) {
        params.store.releaseClaim(
          params.runtime.agentId,
          params.runtime.conversationId,
          params.terminal.id,
          params.connectionId,
        );
      }
    })
    .catch((error) => {
      debugWarn(
        "recovery",
        "Failed to reconcile terminal delivery claim",
        error,
      );
    });
}

export function emitDurableTurnFinished(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  message: ReplayableTurnFinished,
  routing: Parameters<typeof emitProtocolV2Message>[4],
  providedStore?: ReturnType<typeof createTurnFinishedStore>,
  prepared = prepareTurnFinished(runtime, message, providedStore),
): void {
  if (prepared.kind === "ephemeral") {
    emitProtocolV2Message(
      socket,
      runtime,
      message,
      {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      },
      routing,
    );
    return;
  }
  const authorityStatus = terminalAuthorityStatus(runtime, prepared.terminal);
  if (authorityStatus !== "current") {
    if (authorityStatus === "stale") {
      prepared.store.remove(
        runtime.agentId,
        runtime.conversationId,
        prepared.terminal.id,
      );
    }
    return;
  }
  const ownerId = prepared.terminal.owner.connectionId;
  if (!ownerId || !isEligibleOwner(runtime, prepared.terminal, ownerId)) return;
  const claimed = prepared.store.claim(
    runtime.agentId,
    runtime.conversationId,
    prepared.terminal.id,
    ownerId,
  );
  if (claimed) {
    observeDefiniteDrop({
      delivery: sendClaimedTerminal(socket, runtime, ownerId, claimed),
      store: prepared.store,
      runtime,
      terminal: claimed,
      connectionId: ownerId,
    });
  }
}

export function replayPendingTurnFinishedToConnection(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  connectionId: string,
  providedStore?: ReturnType<typeof createTurnFinishedStore>,
): void {
  const connection = runtime.listener.connections.get(connectionId);
  const runtimeKey = getConversationRuntimeKey(
    runtime.agentId,
    runtime.conversationId,
  );
  // Generic initialized observers must not even open the owner durability
  // namespace. Only an explicitly scoped subscriber can be considered.
  if (!connection?.initialized || !connection.subscriptions.has(runtimeKey)) {
    return;
  }
  const store = providedStore ?? createTurnFinishedStore();
  const record = store.read(runtime.agentId, runtime.conversationId);
  if (!record) return;
  for (const terminal of record.terminals) {
    const authorityStatus = terminalAuthorityStatus(runtime, terminal);
    if (authorityStatus !== "current") {
      if (authorityStatus === "stale") {
        store.remove(runtime.agentId, runtime.conversationId, terminal.id);
      }
      continue;
    }
    if (!isEligibleOwner(runtime, terminal, connectionId)) continue;
    const inFlightKey = JSON.stringify([
      runtime.agentId,
      runtime.conversationId,
      terminal.id,
      connectionId,
    ]);
    if (replayInFlight.has(inFlightKey)) continue;
    const claimed = store.claim(
      runtime.agentId,
      runtime.conversationId,
      terminal.id,
      connectionId,
    );
    if (!claimed) continue;
    replayInFlight.add(inFlightKey);
    try {
      observeDefiniteDrop({
        delivery: sendClaimedTerminal(socket, runtime, connectionId, claimed),
        store,
        runtime,
        terminal: claimed,
        connectionId,
      });
    } finally {
      replayInFlight.delete(inFlightKey);
    }
  }
}

/** Retire only after the exact peer which received the stable identity acks it. */
export function acknowledgeTurnFinished(params: {
  runtime?: ConversationRuntime;
  agentId?: string | null;
  conversationId?: string;
  connectionId: string;
  idempotencyKey: string;
  consumerId: string;
  store?: ReturnType<typeof createTurnFinishedStore>;
}): boolean {
  const agentId = params.runtime?.agentId ?? params.agentId ?? null;
  const conversationId =
    params.runtime?.conversationId ?? params.conversationId;
  if (!conversationId) return false;
  try {
    return (params.store ?? createTurnFinishedStore()).acknowledge(
      agentId,
      conversationId,
      params.idempotencyKey,
      params.connectionId,
      params.consumerId,
    );
  } catch (error) {
    debugWarn("recovery", "Failed to retire acknowledged turn-finished", error);
    return false;
  }
}
