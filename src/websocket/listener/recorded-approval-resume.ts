import type { StopReasonType } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import { startRecoveredApprovalContinuation } from "./recovery";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { handleIncomingMessage } from "./turn";
import type { ConversationRuntime, ListenerRuntime } from "./types";

/**
 * Whether the server may still be waiting on the recorded run's approvals.
 *
 * A run that stopped with `requires_approval` is finished from the server's
 * point of view, but its approval requests stay pending until a listener
 * answers them. When the listener's process stopped before it saw or finished
 * those requests (for example the machine shut down mid-turn), a restarted
 * listener has to answer them or the turn never completes.
 */
export function recordedRunAwaitsApproval(run: {
  status?: string | null;
  stop_reason?: StopReasonType | null;
}): boolean {
  return (
    run.status === "running" ||
    run.status === "created" ||
    run.stop_reason === "requires_approval"
  );
}

/**
 * Resume a recorded turn whose pending approvals include unstarted calls.
 *
 * This is the same continuation an execution owner's
 * `sync { resume_interrupted_turn: true }` starts. A restarted listener on a
 * stopped and resumed machine has no other owner to send that sync, so it
 * starts the continuation itself once startup recovery has finished. Retries
 * through `retry` when ownership is not yet resolvable.
 */
export function resumeRecordedUnstartedApprovals(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
  scope: { agent_id: string; conversation_id: string },
  retry: () => void,
  deps: Partial<{
    recover: typeof recoverApprovalStateForSync;
    startContinuation: typeof startRecoveredApprovalContinuation;
    retryDelayMs: number;
  }> = {},
): void {
  const scheduleRetry = () => {
    if (listener.intentionallyClosed) return;
    setTimeout(retry, deps.retryDelayMs ?? 5000).unref();
  };
  setImmediate(() => {
    void (async () => {
      if (listener.intentionallyClosed) return;
      const outcome = await (deps.recover ?? recoverApprovalStateForSync)(
        runtime,
        scope,
        undefined,
        { resumeInterruptedTurn: true },
      );
      if (outcome === "deferred") {
        scheduleRetry();
        return;
      }
      const started = await (
        deps.startContinuation ?? startRecoveredApprovalContinuation
      )(runtime, getOrCreateProcessTransport(listener), handleIncomingMessage);
      if (!started && runtime.recoveredApprovalState) scheduleRetry();
    })().catch((error) => {
      debugWarn("recovery", "Recorded approval resume failed", error);
      scheduleRetry();
    });
  });
}

/**
 * Startup recovery for owned pending approvals that the record proves never
 * started. Returns "none" when there are none, so the caller replays recorded
 * results (and stale denials) itself. Otherwise releases the caller's claim
 * before the continuation acquires its own; a recovery-claim completion
 * lineage keeps waiting for its own retry ("defer").
 */
export async function resumeIfRecordedApprovalsUnstarted(params: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  record: InterruptedTurnRecord;
  ownedToolCallIds: string[];
  hasRecoveryCompletion: boolean;
  releaseClaim: () => Promise<void>;
  retry: () => void;
}): Promise<"none" | "defer" | "resuming"> {
  const { record } = params;
  if (
    !params.ownedToolCallIds.some((id) =>
      record.unstartedToolCallIds?.includes(id),
    )
  ) {
    return "none";
  }
  await params.releaseClaim();
  if (params.hasRecoveryCompletion) return "defer";
  resumeRecordedUnstartedApprovals(
    params.listener,
    params.runtime,
    { agent_id: record.agentId, conversation_id: record.conversationId },
    params.retry,
  );
  return "resuming";
}
