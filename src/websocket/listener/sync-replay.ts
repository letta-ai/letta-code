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
import type {
  ConversationRuntime,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";
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
  opts?: {
    recoverApprovals?: boolean;
    /** Only the sync command performs automatic process-start recovery. */
    recoverOnFirstSync?: boolean;
    recoverApprovalStateForSync?: (
      runtime: ConversationRuntime,
      scope: RuntimeScope<string | null>,
    ) => Promise<void>;
    /** Turn processor for a recovered continuation; defaults to the real turn. */
    processIncomingMessage?: typeof handleIncomingMessage;
    recoveredContinuationDependencies?: RecoveredContinuationDependencies;
    scheduleWarmupsAfterSync?: (
      runtime: ListenerRuntime,
      scope: RuntimeScope<string | null>,
    ) => void;
    forceDeviceStatus?: boolean;
    onStatusChange?: StartListenerOptions["onStatusChange"];
    connectionId?: string;
  },
): Promise<void> {
  const syncScopedRuntime = getOrCreateScopedRuntime(
    listenerRuntime,
    scope.agent_id,
    scope.conversation_id,
  );
  const recoverFn =
    opts?.recoverApprovalStateForSync ?? recoverApprovalStateForSync;
  // The sync command decides whether startup recovery is needed. Other
  // callers, including teleport's runtime_start, can explicitly skip it.
  if (
    (opts?.recoverApprovals ?? true) ||
    (opts?.recoverOnFirstSync &&
      !syncScopedRuntime.syncApprovalRecoveryCompleted)
  ) {
    try {
      await recoverFn(syncScopedRuntime, scope);
      syncScopedRuntime.syncApprovalRecoveryCompleted = true;
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

  // Recovery found only replay-unsafe pending approvals: nothing waits on a
  // human, so finish the interrupted turn now. The continuation takes the
  // turn lease synchronously, so the status replay below already reports it.
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
