import { randomUUID } from "node:crypto";
import type { StopReasonType } from "@/types/protocol_v2";
import { promotePreparedInputTerminals } from "./conversation-runtime";
import {
  dispositionKey,
  durableTransaction,
  getLedger,
  hasCompletedInputTerminalRevision,
  syncMemoryFromDurable,
  teleportInputIdentity,
} from "./input-disposition";
import {
  hasPreparedInputTerminalRevision,
  prepareInputTerminal,
} from "./input-terminal-journal";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import {
  type createTurnFinishedStore,
  getTurnFinishedOwner,
} from "./turn-finished-replay";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function hasCompletedTeleportInput(
  listener: ListenerRuntime,
  runtimeKey: string,
  teleportId: string,
): boolean {
  const ledger = getLedger(listener);
  const key = dispositionKey(runtimeKey, teleportInputIdentity(teleportId));
  const matches = () => {
    const entry = ledger.entries.get(key);
    return entry?.replayCompleted === true && entry.queuedInput === undefined;
  };
  if (!ledger.persistentPath) return matches();
  return durableTransaction(ledger.persistentPath, (store) => {
    syncMemoryFromDurable(ledger, store);
    return { result: matches(), changed: false };
  });
}

export function prepareRecordedInputTerminal(
  listener: ListenerRuntime,
  terminalStore: ReturnType<typeof createTurnFinishedStore>,
  runtime: ConversationRuntime,
  record: InterruptedTurnRecord,
  runId: string | null,
  stopReason: StopReasonType = "end_turn",
): boolean {
  const identities = record.durableInputIdentities ?? [];
  if (!identities.length || !record.revision) return true;
  const scope = {
    agentId: record.agentId,
    conversationId: record.conversationId,
  };
  if (
    hasCompletedInputTerminalRevision(
      listener,
      runtime.key,
      identities,
      record.revision,
    )
  ) {
    return true;
  }
  const eligibleConnections = [...listener.connections.values()]
    .filter(
      (connection) =>
        connection.initialized && connection.subscriptions.has(runtime.key),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const activeConnection = runtime.activeConnectionId
    ? listener.connections.get(runtime.activeConnectionId)
    : undefined;
  const ownerConnection =
    activeConnection?.initialized &&
    activeConnection.subscriptions.has(runtime.key)
      ? activeConnection
      : eligibleConnections.find(
          (connection) => connection.options.connectionIdCanResume !== false,
        );
  const owner = getTurnFinishedOwner(runtime, record.revision);
  owner.connectionId = ownerConnection?.id ?? null;
  owner.canRotate = ownerConnection?.options.connectionIdCanResume === false;
  owner.lineageId = ownerConnection?.startupOwner.lineageId ?? null;
  if (
    !prepareInputTerminal(runtime, identities, {
      scope,
      message: {
        type: "turn_finished",
        turn_id: `turn-recovered-complete-${randomUUID()}`,
        stop_reason: stopReason,
        ...(record.terminalConsumerIds?.length
          ? { terminal_consumer_ids: [...new Set(record.terminalConsumerIds)] }
          : {}),
        ...(runId ? { run_id: runId } : {}),
      },
      owner,
    })
  ) {
    return false;
  }
  promotePreparedInputTerminals(listener, terminalStore, scope);
  return !hasPreparedInputTerminalRevision(listener, scope, record.revision);
}
