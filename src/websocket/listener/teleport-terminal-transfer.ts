import { hasPreparedInputTerminalRevision } from "./input-terminal-journal";
import { recordListenerWork } from "./interrupted-turn-record";
import { createTurnFinishedStore } from "./turn-finished-replay";
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

export function hasDurableTeleportTerminal(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  revision: string,
): boolean {
  try {
    const scope = {
      agentId: pending.agentId,
      conversationId: pending.conversationId,
    };
    if (hasPreparedInputTerminalRevision(runtime.listener, scope, revision)) {
      return true;
    }
    return Boolean(
      createTurnFinishedStore()
        .read(pending.agentId, pending.conversationId)
        ?.terminals.some(
          (terminal) => terminal.owner.interruptedRevision === revision,
        ),
    );
  } catch {
    // A failed durable read cannot prove the terminal was absent. Preserve the
    // exact intent so restart recovery can classify it after storage recovers.
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

export function journalTeleportIntent(
  runtime: ConversationRuntime,
  pending: PendingTeleport,
  expectedRevision?: string,
): string | undefined {
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
  return journalTeleportIntent(runtime, pending, expectedRevision);
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
