import { getInboundClientMessageIds } from "./inbound-queue";
import { getConversationRuntimeKey } from "./runtime";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
} from "./types";

const MAX_CLIENT_MESSAGE_IDS_PER_RUN = 32;
const MAX_RECENT_RUN_CORRELATIONS = 32;
const MAX_RECENT_CONVERSATIONS = 256;

export type TurnCorrelationIndex = Map<string, Map<string, string[]>>;

/**
 * Merge bounded correlation snapshots from oldest to newest. Re-inserting every
 * touched key makes later snapshots authoritative for eviction order while
 * retaining mappings that only exist in an older private handoff snapshot.
 */
export function mergeTurnCorrelationIndexes(
  ...sources: Array<TurnCorrelationIndex | undefined>
): TurnCorrelationIndex {
  const merged: TurnCorrelationIndex = new Map();
  for (const source of sources) {
    for (const [conversationKey, runs] of source ?? []) {
      const mergedRuns = merged.get(conversationKey) ?? new Map();
      for (const [runId, clientMessageIds] of runs) {
        const mergedClientMessageIds = [
          ...new Set([...(mergedRuns.get(runId) ?? []), ...clientMessageIds]),
        ].slice(-MAX_CLIENT_MESSAGE_IDS_PER_RUN);
        mergedRuns.delete(runId);
        mergedRuns.set(runId, mergedClientMessageIds);
        while (mergedRuns.size > MAX_RECENT_RUN_CORRELATIONS) {
          const oldestRunId = mergedRuns.keys().next().value;
          if (!oldestRunId) break;
          mergedRuns.delete(oldestRunId);
        }
      }
      merged.delete(conversationKey);
      merged.set(conversationKey, mergedRuns);
      while (merged.size > MAX_RECENT_CONVERSATIONS) {
        const oldestConversationKey = merged.keys().next().value;
        if (!oldestConversationKey) break;
        merged.delete(oldestConversationKey);
      }
    }
  }
  return merged;
}

export function cloneTurnCorrelationIndex(
  source: TurnCorrelationIndex | undefined,
): TurnCorrelationIndex {
  return mergeTurnCorrelationIndexes(source);
}

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
  readonly clientMessageIds: string[];
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
    get clientMessageIds() {
      return [...clientMessageIds];
    },
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
      correlations.set(
        runId,
        [...merged].slice(-MAX_CLIENT_MESSAGE_IDS_PER_RUN),
      );
      while (correlations.size > MAX_RECENT_RUN_CORRELATIONS) {
        const oldestRunId = correlations.keys().next().value;
        if (!oldestRunId) break;
        correlations.delete(oldestRunId);
      }
    },
  };
}
