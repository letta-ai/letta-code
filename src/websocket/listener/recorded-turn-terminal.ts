import { randomUUID } from "node:crypto";
import type { StopReasonType } from "@/types/protocol_v2";
import { promotePreparedInputTerminals } from "./conversation-runtime";
import {
  dispositionKey,
  durableTransaction,
  getLedger,
  syncMemoryFromDurable,
  teleportInputIdentity,
} from "./input-disposition";
import {
  hasCompletedInputTerminalAuthority,
  hasCompletedInputTerminalRevision,
} from "./input-terminal-evidence";
import {
  hasPreparedInputTerminalAuthority,
  hasPreparedInputTerminalRevision,
  prepareInputTerminal,
} from "./input-terminal-journal";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import {
  type createTurnFinishedStore,
  getTurnFinishedOwner,
} from "./turn-finished-replay";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function hasRecordedTerminalEvidence(
  listener: ListenerRuntime,
  terminalStore: ReturnType<typeof createTurnFinishedStore>,
  params: {
    agentId: string;
    conversationId: string;
    runtimeKey: string;
    identities: InterruptedTurnRecord["durableInputIdentities"];
    revision: string;
    authorityRevision?: string;
    recoveryLineageId?: string;
  },
): boolean {
  const authority =
    params.recoveryLineageId && params.authorityRevision
      ? {
          interruptedRevision: params.revision,
          authorityRevision: params.authorityRevision,
          recoveryLineageId: params.recoveryLineageId,
        }
      : undefined;
  return (
    (authority
      ? hasCompletedInputTerminalAuthority(
          listener,
          params.runtimeKey,
          params.identities ?? [],
          authority,
        )
      : hasCompletedInputTerminalRevision(
          listener,
          params.runtimeKey,
          params.identities ?? [],
          params.revision,
        )) ||
    terminalStore
      .read(params.agentId, params.conversationId)
      ?.terminals.some(
        (terminal) =>
          terminal.owner.interruptedRevision === params.revision &&
          (authority
            ? terminal.owner.recoveryLineageId ===
                authority.recoveryLineageId &&
              terminal.owner.interruptedAuthorityRevision ===
                authority.authorityRevision
            : terminal.owner.recoveryLineageId === undefined),
      ) === true
  );
}

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
  authority?: { revisionToken: string; lineageId: string },
): boolean {
  const identities = record.durableInputIdentities ?? [];
  if (!identities.length || !record.revision) return true;
  const scope = {
    agentId: record.agentId,
    conversationId: record.conversationId,
  };
  const terminalAuthority = authority
    ? {
        interruptedRevision: record.revision,
        authorityRevision: authority.revisionToken,
        recoveryLineageId: authority.lineageId,
      }
    : undefined;
  if (
    terminalAuthority
      ? hasCompletedInputTerminalAuthority(
          listener,
          runtime.key,
          identities,
          terminalAuthority,
        )
      : hasCompletedInputTerminalRevision(
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
  if (terminalAuthority) {
    owner.recoveryLineageId = terminalAuthority.recoveryLineageId;
    owner.interruptedAuthorityRevision = terminalAuthority.authorityRevision;
  }
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
  return terminalAuthority
    ? !hasPreparedInputTerminalAuthority(listener, scope, terminalAuthority)
    : !hasPreparedInputTerminalRevision(listener, scope, record.revision);
}
