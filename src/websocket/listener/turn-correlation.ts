import { getInboundClientMessageIds } from "./inbound-queue";
import { getConversationRuntimeKey } from "./runtime";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
} from "./types";

const MAX_RECENT_RUN_CORRELATIONS = 32;
const MAX_RECENT_CONVERSATIONS = 256;

function takeDequeuedClientMessageIds(
  runtime: ConversationRuntime,
  batchId: string,
): string[] {
  const clientMessageIds =
    runtime.dequeuedClientMessageIdsByBatchId.get(batchId) ?? [];
  runtime.dequeuedClientMessageIdsByBatchId.delete(batchId);
  return clientMessageIds;
}

export interface TurnCorrelation {
  appendDequeuedBatch: (batchId: string) => void;
  observeRun: (runId: string) => void;
}

export function buildTurnCorrelationSnapshot(
  listener: ListenerRuntime,
  agentId: string | null,
  conversationId: string | null,
): { client_message_ids_by_run_id?: Record<string, string[]> } {
  const correlations = listener.clientMessageIdsByRunIdByConversation?.get(
    getConversationRuntimeKey(agentId, conversationId),
  );
  return correlations && correlations.size > 0
    ? { client_message_ids_by_run_id: Object.fromEntries(correlations) }
    : {};
}

export function createTurnCorrelation(
  runtime: ConversationRuntime,
  message: IncomingMessage,
  batchId: string,
): TurnCorrelation {
  const clientMessageIds = new Set([
    ...getInboundClientMessageIds(message),
    ...takeDequeuedClientMessageIds(runtime, batchId),
  ]);
  let correlationsByConversation =
    runtime.listener.clientMessageIdsByRunIdByConversation;
  if (!correlationsByConversation) {
    correlationsByConversation = new Map();
    runtime.listener.clientMessageIdsByRunIdByConversation =
      correlationsByConversation;
  }
  let correlations = correlationsByConversation.get(runtime.key);
  if (!correlations) {
    correlations = new Map();
    correlationsByConversation.set(runtime.key, correlations);
    while (correlationsByConversation.size > MAX_RECENT_CONVERSATIONS) {
      let oldestEvictedRuntimeKey: string | undefined;
      for (const key of correlationsByConversation.keys()) {
        if (
          key !== runtime.key &&
          !runtime.listener.conversationRuntimes.has(key)
        ) {
          oldestEvictedRuntimeKey = key;
          break;
        }
      }
      if (!oldestEvictedRuntimeKey) break;
      correlationsByConversation.delete(oldestEvictedRuntimeKey);
    }
  }
  return {
    appendDequeuedBatch(nextBatchId) {
      for (const clientMessageId of takeDequeuedClientMessageIds(
        runtime,
        nextBatchId,
      )) {
        clientMessageIds.add(clientMessageId);
      }
    },
    observeRun(runId) {
      if (clientMessageIds.size === 0) return;
      const merged = new Set([
        ...(correlations.get(runId) ?? []),
        ...clientMessageIds,
      ]);
      correlations.delete(runId);
      correlations.set(runId, [...merged]);
      while (correlations.size > MAX_RECENT_RUN_CORRELATIONS) {
        const oldestRunId = correlations.keys().next().value;
        if (!oldestRunId) break;
        correlations.delete(oldestRunId);
      }
    },
  };
}
