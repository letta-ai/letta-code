import { APIError } from "@letta-ai/letta-client/core/error";
import type { getBackend } from "@/backend";
import type { createInterruptedTurnStore } from "./interrupted-turn-record";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import { allRecordedResults } from "./recorded-tool-results";

const missingRuns = new WeakMap<
  object,
  {
    otid: string;
    revision?: string;
    firstMissAt: number;
    attempts: number;
  }
>();

export async function resolveRecordedRunId(
  backend: ReturnType<typeof getBackend>,
  record: InterruptedTurnRecord,
  pendingApprovals: readonly { toolCallId: string }[],
  recoveryScope: object,
): Promise<
  | { status: "found"; runId: string }
  | { status: "deferred" }
  | { status: "not_found" }
> {
  const requiresResolution =
    !record.runId ||
    (allRecordedResults(record).length > 0 &&
      (!pendingApprovals.length ||
        pendingApprovals.some(
          (approval) => !record.toolCallIds.includes(approval.toolCallId),
        )));
  if (!requiresResolution && record.runId)
    return { status: "found", runId: record.runId };
  if (!record.requestOtid) return { status: "deferred" };

  const previous = missingRuns.get(recoveryScope);
  const missing =
    previous?.otid === record.requestOtid &&
    previous.revision === record.revision
      ? previous
      : undefined;
  if (missing && Date.now() < missing.firstMissAt + missing.attempts * 15_000) {
    return { status: "deferred" };
  }
  try {
    const stream = await backend.streamConversationMessages(
      record.conversationId,
      {
        otid: record.requestOtid,
        starting_after: 0,
        ...(record.conversationId === "default"
          ? { agent_id: record.agentId }
          : {}),
      },
      { signal: AbortSignal.timeout(5000), maxRetries: 0 },
    );
    try {
      for await (const chunk of stream) {
        if ("run_id" in chunk && typeof chunk.run_id === "string") {
          missingRuns.delete(recoveryScope);
          return { status: "found", runId: chunk.run_id };
        }
      }
      return { status: "deferred" };
    } finally {
      stream.controller.abort();
    }
  } catch (error) {
    if (!(error instanceof APIError) || error.status !== 404) throw error;
    const state = missing ?? {
      otid: record.requestOtid,
      revision: record.revision,
      firstMissAt: Date.now(),
      attempts: 0,
    };
    state.attempts++;
    missingRuns.set(recoveryScope, state);
    if (state.attempts >= 3 && Date.now() - state.firstMissAt >= 30_000) {
      missingRuns.delete(recoveryScope);
      return { status: "not_found" };
    }
    return { status: "deferred" };
  }
}

export function retireMissingRun(
  store: ReturnType<typeof createInterruptedTurnStore>,
  record: InterruptedTurnRecord,
  missingAndUnchanged: boolean,
): boolean {
  return (
    missingAndUnchanged &&
    !record.recoveryClaimCompletion &&
    store.remove(record.agentId, record.conversationId, record.revision ?? null)
  );
}
