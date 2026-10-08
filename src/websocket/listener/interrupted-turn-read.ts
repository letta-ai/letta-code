import { createInterruptedTurnStore } from "./interrupted-turn-record";
import type { ConversationRuntime } from "./types";

export function readInterruptedTurn(
  runtime: ConversationRuntime,
  recoveryLineageId?: string,
) {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return null;
  const store = createInterruptedTurnStore();
  return recoveryLineageId
    ? store.readRecoveryView(
        runtime.agentId,
        runtime.conversationId,
        recoveryLineageId,
      )
    : store.read(runtime.agentId, runtime.conversationId);
}

export function readInterruptedTurnAuthorityRevision(
  runtime: ConversationRuntime,
  recoveryLineageId: string,
): string | undefined {
  if (!runtime.agentId || !runtime.listener.connectionId?.startsWith("conn-"))
    return undefined;
  const store = createInterruptedTurnStore();
  const main = store.read(runtime.agentId, runtime.conversationId);
  const completion = main?.recoveryClaimCompletion;
  if (completion?.lineageId !== recoveryLineageId) return undefined;
  if (!completion.independentSuccessor) return main?.revision;
  const snapshot = store.readRecoverySnapshot(
    runtime.agentId,
    runtime.conversationId,
    recoveryLineageId,
  );
  return snapshot?.revisionToken;
}
