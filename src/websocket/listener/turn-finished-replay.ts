import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import type { TurnFinishedMessage } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { toListenerConnection } from "./connection";
import type { OutboundMessageDelivery } from "./outbound-delivery";
import { emitProtocolV2Message } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ConversationRuntime } from "./types";

export type ReplayableTurnFinished = Omit<
  TurnFinishedMessage,
  "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
>;

type PersistedTurnFinished = {
  id: string;
  message: ReplayableTurnFinished;
};

type PersistedTurnFinishedRecord = {
  agentId: string | null;
  conversationId: string;
  terminals: PersistedTurnFinished[];
};

const MAX_PENDING_TERMINALS_PER_CONVERSATION = 64;

function defaultDirectory(): string {
  return join(
    homedir(),
    ".letta",
    "listener-terminal-state",
    createHash("sha256").update(getServerUrl()).digest("hex").slice(0, 24),
  );
}

export function createTurnFinishedStore(directory = defaultDirectory()) {
  const path = (agentId: string | null, conversationId: string) =>
    join(
      directory,
      `${agentId === null ? "null" : `agent-${encodeURIComponent(agentId)}`}_${encodeURIComponent(conversationId)}.json`,
    );
  const read = (
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
            terminal.message?.type === "turn_finished" &&
            typeof terminal.message.turn_id === "string",
        )
      ) {
        throw new Error("Invalid turn-finished record");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        debugWarn(
          "recovery",
          "Ignoring unreadable turn-finished record",
          error,
        );
      }
      return null;
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
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  const lockWait = new Int32Array(new SharedArrayBuffer(4));
  const withRecordLock = <T>(
    agentId: string | null,
    conversationId: string,
    operation: () => T,
  ): T => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = `${path(agentId, conversationId)}.lock`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        mkdirSync(lock, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) {
            rmSync(lock, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw statError;
        }
        Atomics.wait(lockWait, 0, 0, 10);
        continue;
      }
      try {
        return operation();
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
    throw new Error("Timed out acquiring turn-finished durability lock");
  };
  return {
    read,
    put(
      agentId: string | null,
      conversationId: string,
      message: ReplayableTurnFinished,
    ): PersistedTurnFinished {
      return withRecordLock(agentId, conversationId, () => {
        const record = read(agentId, conversationId) ?? {
          agentId,
          conversationId,
          terminals: [],
        };
        const existing = record.terminals.find(
          (terminal) => terminal.message.turn_id === message.turn_id,
        );
        if (existing) return existing;
        if (record.terminals.length >= MAX_PENDING_TERMINALS_PER_CONVERSATION) {
          throw new Error("Pending turn-finished durability capacity exceeded");
        }
        const terminal = { id: randomUUID(), message };
        record.terminals.push(terminal);
        write(record);
        return terminal;
      });
    },
    remove(agentId: string | null, conversationId: string, id: string): void {
      withRecordLock(agentId, conversationId, () => {
        const record = read(agentId, conversationId);
        if (!record) return;
        record.terminals = record.terminals.filter(
          (terminal) => terminal.id !== id,
        );
        if (record.terminals.length === 0) {
          rmSync(path(agentId, conversationId), { force: true });
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

/** Persist the authoritative terminal before its lease is finalized. */
export function prepareTurnFinished(
  runtime: ConversationRuntime,
  message: ReplayableTurnFinished,
  providedStore?: ReturnType<typeof createTurnFinishedStore>,
): PreparedTurnFinished {
  if (!providedStore && !runtime.listener.connectionId?.startsWith("conn-")) {
    return { kind: "ephemeral" };
  }
  const store = providedStore ?? createTurnFinishedStore();
  return {
    kind: "durable",
    store,
    terminal: store.put(runtime.agentId, runtime.conversationId, message),
  };
}

function observeDelivery(params: {
  delivery: OutboundMessageDelivery;
  agentId: string | null;
  conversationId: string;
  terminalId: string;
  requiredConnectionId: string | null;
  inFlightKey?: string;
  store?: ReturnType<typeof createTurnFinishedStore>;
}): void {
  const { delivery, agentId, conversationId, terminalId, inFlightKey } = params;
  if (delivery.receipts.length === 0) {
    if (inFlightKey) replayInFlight.delete(inFlightKey);
    return;
  }
  void Promise.all(
    delivery.receipts.map(async (receipt) => ({
      connectionId: receipt.connectionId,
      settlement: await receipt.settlement,
    })),
  )
    .then((settlements) => {
      if (
        settlements.some(
          ({ connectionId, settlement }) =>
            settlement === "sent" &&
            connectionId === params.requiredConnectionId,
        )
      ) {
        (params.store ?? createTurnFinishedStore()).remove(
          agentId,
          conversationId,
          terminalId,
        );
      }
    })
    .finally(() => {
      if (inFlightKey) replayInFlight.delete(inFlightKey);
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
  const outboundMessage =
    prepared.kind === "durable" ? prepared.terminal.message : message;
  if (prepared.kind === "ephemeral") {
    emitProtocolV2Message(
      socket,
      runtime,
      outboundMessage,
      {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      },
      routing,
    );
    return;
  }
  const delivery = emitProtocolV2Message(
    socket,
    runtime,
    outboundMessage,
    {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    },
    routing,
  );
  observeDelivery({
    delivery,
    agentId: runtime.agentId,
    conversationId: runtime.conversationId,
    terminalId: prepared.terminal.id,
    requiredConnectionId:
      runtime.activeConnectionId ?? runtime.listener.connectionId,
    store: prepared.store,
  });
}

export function replayPendingTurnFinishedToConnection(
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  connectionId: string,
  providedStore?: ReturnType<typeof createTurnFinishedStore>,
): void {
  if (!providedStore && !runtime.listener.connectionId?.startsWith("conn-")) {
    return;
  }
  const store = providedStore ?? createTurnFinishedStore();
  const record = store.read(runtime.agentId, runtime.conversationId);
  if (!record) return;
  for (const terminal of record.terminals) {
    const inFlightKey = `${runtime.agentId}\u0000${runtime.conversationId}\u0000${terminal.id}\u0000${connectionId}`;
    if (replayInFlight.has(inFlightKey)) continue;
    replayInFlight.add(inFlightKey);
    const delivery = emitProtocolV2Message(
      socket,
      runtime,
      terminal.message,
      {
        agent_id: runtime.agentId,
        conversation_id: runtime.conversationId,
      },
      toListenerConnection(connectionId),
    );
    observeDelivery({
      delivery,
      agentId: runtime.agentId,
      conversationId: runtime.conversationId,
      terminalId: terminal.id,
      requiredConnectionId: connectionId,
      inFlightKey,
      store,
    });
  }
}
