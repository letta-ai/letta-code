import type WebSocket from "ws";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import type { RuntimeScope } from "@/types/protocol_v2";
import { isDebugEnabled } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import { replaySubscribedConnectionState } from "./connection-state-sync";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  type RecoveredContinuationDependencies,
  startRecoveredApprovalContinuation,
} from "./recovery";
import { recoverApprovalStateForSync } from "./recovery-sync";
import { handleIncomingMessage } from "./turn";
import type { ListenerRuntime, SyncReplayOptions } from "./types";
import { scheduleListenerWarmupsAfterSync } from "./warmup";

/**
 * Everything the listener does when a connection sends `sync` (or a
 * `runtime_start` asks for the same replay): recover backend approval state
 * for the scope, resume an interrupted turn when nothing waits on a human,
 * replay the scope's state to the connection, and schedule warmups.
 */
export async function replaySyncStateForRuntime(
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: RuntimeScope<string | null>,
  opts?: SyncReplayOptions & {
    recoverApprovalStateForSync?: (
      ...args: Parameters<typeof recoverApprovalStateForSync>
    ) => Promise<unknown>;
    /** Turn processor for a recovered continuation; defaults to the real turn. */
    processIncomingMessage?: typeof handleIncomingMessage;
    recoveredContinuationDependencies?: RecoveredContinuationDependencies;
    scheduleWarmupsAfterSync?: (
      runtime: ListenerRuntime,
      scope: RuntimeScope<string | null>,
    ) => void;
  },
): Promise<void> {
  const syncScopedRuntime = getOrCreateScopedRuntime(
    listenerRuntime,
    scope.agent_id,
    scope.conversation_id,
  );
  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;
  // Recovery runs only when the sender asked for it. cloud-api's readiness
  // probes and activity claims send recover_approvals=false so a prewarmed or
  // idle sandbox never touches a conversation it merely observes.
  if (opts?.recoverApprovals ?? true) {
    try {
      await recoverFn(syncScopedRuntime, scope, undefined, {
        resumeInterruptedTurn: opts?.resumeInterruptedTurn === true,
      });
    } catch (error) {
      trackBoundaryError({
        errorType: "listener_sync_recovery_failed",
        error,
        context: "listener_sync_recovery",
      });
      if (isDebugEnabled()) {
        console.warn("[Listen] Sync approval recovery failed:", error);
      }
    }
  }

  // The execution owner asked to resume and recovery found only replay-unsafe
  // pending approvals: nothing waits on a human, so try to finish the
  // interrupted turn. (An observer's sync parked those denials for this
  // listener's next user message instead and never reaches this state.) The
  // shared recovery entry verifies ownership before acquiring the local turn
  // lease; sync must not start a competing turn during either side of a
  // teleport.
  if (
    syncScopedRuntime.recoveredApprovalState &&
    syncScopedRuntime.recoveredApprovalState.pendingRequestIds.size === 0 &&
    (syncScopedRuntime.recoveredApprovalState.autoDecisions?.length ?? 0) > 0
  ) {
    void startRecoveredApprovalContinuation(
      syncScopedRuntime,
      getOrCreateProcessTransport(listenerRuntime),
      opts?.processIncomingMessage ?? handleIncomingMessage,
      {
        onStatusChange: opts?.onStatusChange,
        connectionId: opts?.connectionId,
        dependencies: opts?.recoveredContinuationDependencies,
      },
    ).catch((error) => {
      trackBoundaryError({
        errorType: "listener_startup_approval_recovery_failed",
        error,
        context: "listener_startup_approval_recovery",
      });
      if (isDebugEnabled()) {
        console.error("[Listen] startup approval recovery failed:", error);
      }
    });
  }

  await replaySubscribedConnectionState(
    listenerRuntime,
    socket,
    syncScopedRuntime,
    scope,
    opts,
  );
  (opts?.scheduleWarmupsAfterSync ?? scheduleListenerWarmupsAfterSync)(
    listenerRuntime,
    scope,
  );
}
