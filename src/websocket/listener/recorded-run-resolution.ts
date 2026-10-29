import type { getBackend } from "@/backend";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import { allRecordedResults } from "./recorded-tool-results";

/** Resolve the run created by this exact accepted request; never reuse an older run. */
export async function resolveRecordedRunId(
  backend: ReturnType<typeof getBackend>,
  record: InterruptedTurnRecord,
  pendingApprovals: readonly { toolCallId: string }[],
): Promise<string | undefined> {
  const requiresResolution =
    !record.runId ||
    (allRecordedResults(record).length > 0 &&
      (!pendingApprovals.length ||
        pendingApprovals.some(
          (approval) => !record.toolCallIds.includes(approval.toolCallId),
        )));
  if (!requiresResolution) return record.runId ?? undefined;
  if (!record.requestOtid) return undefined;

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
        return chunk.run_id;
      }
    }
    return undefined;
  } finally {
    stream.controller.abort();
  }
}
