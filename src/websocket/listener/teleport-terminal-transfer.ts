import { recordListenerWork } from "./interrupted-turn-record";
import type {
  ConversationRuntime,
  DurablePreparedInputTerminal,
  PendingTeleport,
} from "./types";

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
