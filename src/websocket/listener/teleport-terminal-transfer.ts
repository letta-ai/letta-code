import {
  hasCompletedInputTerminalAuthority,
  hasCompletedInputTerminalRevision,
} from "./input-terminal-evidence";
import {
  hasPreparedInputTerminalAuthority,
  hasPreparedInputTerminalRevision,
} from "./input-terminal-journal";
import {
  createInterruptedTurnStore,
  type InterruptedTurnRecord,
  recordListenerWork,
} from "./interrupted-turn-record";
import {
  createTurnFinishedStore,
  isInterruptedTerminalAuthorityCurrent,
} from "./turn-finished-replay";
import type { TurnFinishTransition } from "./turn-lifecycle";
import type {
  ConversationRuntime,
  DurablePreparedInputTerminal,
  PendingTeleport,
} from "./types";

export class TeleportTerminalConsumerRaceError extends Error {}

export class TeleportIntentUnavailableError extends Error {}

export class TeleportTerminalPreparedError extends Error {
  constructor(readonly terminalCause: unknown) {
    super("Teleport terminal is durable and awaiting recovery");
  }
}

export function terminalConsumersMatch(
  terminal: DurablePreparedInputTerminal,
  expected: readonly string[],
): boolean {
  const actual = terminal.message.terminal_consumer_ids ?? [];
  const expectedSet = new Set(expected);
  return (
    actual.length === expectedSet.size &&
    actual.every((consumerId) => expectedSet.has(consumerId))
  );
}

type TeleportTerminalProof = "present" | "absent" | "ambiguous";

function classifyTeleportTerminal(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  record: InterruptedTurnRecord,
  revision: string | undefined,
): TeleportTerminalProof {
  if (!revision) return "absent";
  try {
    const scope = {
      agentId: pending.agentId,
      conversationId: pending.conversationId,
    };
    const authority = record.teleport?.terminalAuthority;
    if (authority) {
      const status = isInterruptedTerminalAuthorityCurrent(runtime, authority);
      if (status === "unknown") return "ambiguous";
      if (status === "stale") return "absent";
    }
    if (
      authority
        ? hasPreparedInputTerminalAuthority(runtime.listener, scope, authority)
        : hasPreparedInputTerminalRevision(runtime.listener, scope, revision)
    ) {
      return "present";
    }
    const identities = record.durableInputIdentities ?? [];
    if (
      authority
        ? hasCompletedInputTerminalAuthority(
            runtime.listener,
            runtime.key,
            identities,
            authority,
          )
        : hasCompletedInputTerminalRevision(
            runtime.listener,
            runtime.key,
            identities,
            revision,
          )
    ) {
      return "present";
    }
    const terminals = createTurnFinishedStore().readOrThrow(
      pending.agentId,
      pending.conversationId,
    );
    return terminals?.terminals.some((terminal) =>
      authority
        ? terminal.owner.interruptedRevision ===
            authority.interruptedRevision &&
          (terminal.owner.interruptedAuthorityRevision ??
            terminal.owner.interruptedRevision) ===
            authority.authorityRevision &&
          terminal.owner.recoveryLineageId === authority.recoveryLineageId &&
          terminal.owner.terminalIdentity === authority.terminalIdentity
        : terminal.owner.interruptedRevision === revision,
    )
      ? "present"
      : "absent";
  } catch {
    return "ambiguous";
  }
}

export function hasDurableTeleportTerminal(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  revision: string,
): boolean {
  try {
    const record = createInterruptedTurnStore().readOrThrow(
      pending.agentId,
      pending.conversationId,
    );
    return record
      ? classifyTeleportTerminal(runtime, pending, record, revision) !==
          "absent"
      : false;
  } catch {
    return true;
  }
}

export function retainDurableTeleportTerminal(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  revision?: string,
  error?: unknown,
): boolean {
  if (
    !(error instanceof TeleportTerminalPreparedError) &&
    (!revision || !hasDurableTeleportTerminal(runtime, pending, revision))
  ) {
    return false;
  }
  runtime.listener.scheduleRecordedRecovery?.();
  return true;
}

export function retireTeleportTerminalProof(
  record: InterruptedTurnRecord,
  committedRevision: string | undefined,
): void {
  if (!committedRevision) return;
  const store = createTurnFinishedStore();
  const proof = store
    .read(record.agentId, record.conversationId)
    ?.terminals.find(
      (terminal) =>
        terminal.requiredConsumerIds.length === 0 &&
        terminal.owner.interruptedRevision === committedRevision,
    );
  if (proof) store.remove(record.agentId, record.conversationId, proof.id);
}

export function classifyPersistedTeleportTerminal(
  runtime: ConversationRuntime,
  record: InterruptedTurnRecord,
): TeleportTerminalProof {
  const pending: PendingTeleport = {
    teleportId: record.teleport?.teleportId ?? "",
    connectionId: record.teleport?.connectionId ?? "",
    agentId: record.agentId,
    conversationId: record.conversationId,
    requestedAt: 0,
    drainAcceptedInputs: false,
    activeTurn: record.teleport?.activeTurn ?? false,
  };
  const proof = classifyTeleportTerminal(
    runtime,
    pending,
    record,
    record.teleport?.committedRevision ??
      record.teleport?.intentRevision ??
      record.revision,
  );
  if (proof === "ambiguous") runtime.listener.scheduleRecordedRecovery?.();
  return proof;
}

export function persistSuccessorTeleportReady(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  record: InterruptedTurnRecord,
  committedRevision: string,
): InterruptedTurnRecord | undefined {
  if (
    record.teleport?.teleportId !== pending.teleportId ||
    classifyTeleportTerminal(runtime, pending, record, committedRevision) !==
      "present"
  ) {
    runtime.listener.scheduleRecordedRecovery?.();
    return undefined;
  }
  try {
    const store = createInterruptedTurnStore();
    const readyRecord = {
      ...record,
      teleport: {
        ...record.teleport,
        ready: true,
        committedRevision,
        preserveSuccessorWork: true,
      },
    };
    const authority = record.teleport.terminalAuthority;
    return authority?.recoveryLineageId
      ? (store.writeWithRecoveryAuthority({
          record: readyRecord,
          expectedRevision: record.revision ?? "",
          lineageId: authority.recoveryLineageId,
          expectedAuthorityRevision: authority.authorityRevision,
        }) ?? undefined)
      : store.write(readyRecord, record.revision);
  } catch {
    runtime.listener.scheduleRecordedRecovery?.();
    return undefined;
  }
}

export function journalTeleportIntent(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  expectedRevision?: string,
  terminal?: DurablePreparedInputTerminal,
): string | undefined {
  const sidecarAuthority =
    terminal?.owner.recoveryLineageId &&
    terminal.owner.interruptedAuthorityRevision &&
    terminal.owner.interruptedAuthorityRevision !==
      terminal.owner.interruptedRevision;
  return recordListenerWork(
    runtime,
    {
      teleport: {
        teleportId: pending.teleportId,
        connectionId: pending.connectionId,
        connectionGeneration:
          runtime.listener.connectionGeneration ?? undefined,
        activeTurn: pending.activeTurn,
        continuation: pending.continuation,
        ...(terminal
          ? {
              terminalAuthority: {
                interruptedRevision: "",
                authorityRevision: sidecarAuthority
                  ? (terminal.owner.interruptedAuthorityRevision ?? "")
                  : "",
                ...(terminal.owner.recoveryLineageId
                  ? {
                      recoveryLineageId: terminal.owner.recoveryLineageId,
                      ...(sidecarAuthority
                        ? {
                            recoveryAuthorityBaseRevision:
                              terminal.owner.interruptedRevision,
                          }
                        : {}),
                    }
                  : {}),
                ...(terminal.owner.terminalIdentity
                  ? { terminalIdentity: terminal.owner.terminalIdentity }
                  : {}),
                ...(terminal.owner.preparationSequence !== undefined
                  ? {
                      preparationSequence: terminal.owner.preparationSequence,
                    }
                  : {}),
              },
            }
          : {}),
        ready: false,
      },
    },
    "after_tool_execution",
    expectedRevision,
  );
}

export function journalTeleportIntentWithTerminalConsumers(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  terminal: DurablePreparedInputTerminal,
  expectedRevision?: string,
): string | undefined {
  const consumers = terminal.message.terminal_consumer_ids;
  pending.continuation = {
    approvals: pending.continuation?.approvals ?? [],
    ...(consumers?.length
      ? { terminal_consumer_ids: [...new Set(consumers)] }
      : {}),
  };
  return journalTeleportIntent(runtime, pending, expectedRevision, terminal);
}

type TerminalTransferCommit = (options: {
  stopReason: import("@/types/protocol_v2").StopReasonType;
  agentId: string;
  conversationId: string;
  persistTerminalWithoutConsumers?: boolean;
  expectedInterruptedRevision?: string;
  teleportHandoff?: boolean;
  onBeforePrepareInputTerminal?: (
    terminal: DurablePreparedInputTerminal,
  ) => string | false | undefined;
  validatePreparedInputTerminal?: (
    terminal: DurablePreparedInputTerminal,
  ) => boolean;
}) => TurnFinishTransition;

export function commitActiveTeleportTerminalTransfer(params: {
  runtime: ConversationRuntime;
  pending: PendingTeleport;
  commit: TerminalTransferCommit;
  stopReason: import("@/types/protocol_v2").StopReasonType;
  expectedInterruptedRevision?: string;
  onUnavailable: (revision?: string) => string | undefined;
}): { transition: TurnFinishTransition; revision?: string; fallback?: true } {
  const fallback = () => {
    const fallbackRevision =
      params.onUnavailable(revision) ?? params.expectedInterruptedRevision;
    return {
      fallback: true as const,
      transition: params.commit({
        stopReason: params.stopReason,
        agentId: params.pending.agentId,
        conversationId: params.pending.conversationId,
        expectedInterruptedRevision: fallbackRevision,
      }),
    };
  };
  let revision: string | undefined;
  for (let attempt = 0; attempt <= 64; attempt += 1) {
    try {
      const transition = params.commit({
        stopReason: params.stopReason,
        agentId: params.pending.agentId,
        conversationId: params.pending.conversationId,
        persistTerminalWithoutConsumers: true,
        expectedInterruptedRevision:
          revision ?? params.expectedInterruptedRevision,
        teleportHandoff: true,
        onBeforePrepareInputTerminal: (terminal) => {
          revision = journalTeleportIntentWithTerminalConsumers(
            params.runtime,
            params.pending,
            terminal,
            revision ?? params.expectedInterruptedRevision,
          );
          return revision ?? false;
        },
        validatePreparedInputTerminal: (terminal) =>
          terminalConsumersMatch(
            terminal,
            params.pending.continuation?.terminal_consumer_ids ?? [],
          ),
      });
      if (!revision) return fallback();
      return { transition, revision };
    } catch (error) {
      if (error instanceof TeleportIntentUnavailableError) {
        return fallback();
      }
      if (error instanceof TeleportTerminalConsumerRaceError && attempt < 64) {
        continue;
      }
      if (error instanceof TeleportTerminalConsumerRaceError) return fallback();
      if (
        revision &&
        hasDurableTeleportTerminal(params.runtime, params.pending, revision)
      ) {
        throw new TeleportTerminalPreparedError(error);
      }
      params.onUnavailable(revision);
      throw error;
    }
  }
  return fallback();
}
