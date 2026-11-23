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

export async function replaySyncStateForRuntime(
  listenerRuntime: ListenerRuntime,
  socket: WebSocket,
  scope: RuntimeScope<string | null>,
  opts?: SyncReplayOptions & {
    recoverApprovalStateForSync?: (
      ...args: Parameters<typeof recoverApprovalStateForSync>
    ) => Promise<unknown>;
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

  if (
    syncScopedRuntime.recoveredApprovalState &&
    (syncScopedRuntime.recoveredApprovalState.autoDecisions?.length ?? 0) > 0
  ) {
    let signalLeaseReady!: () => void;
    let releaseLeaseBarrier!: () => void;
    const leaseReady = new Promise<void>((resolve) => {
      signalLeaseReady = resolve;
    });
    const leaseBarrier = new Promise<void>((resolve) => {
      releaseLeaseBarrier = resolve;
    });
    const recovery = startRecoveredApprovalContinuation(
      syncScopedRuntime,
      getOrCreateProcessTransport(listenerRuntime),
      opts?.processIncomingMessage ?? handleIncomingMessage,
      {
        onStatusChange: opts?.onStatusChange,
        connectionId: opts?.connectionId,
        dependencies: opts?.recoveredContinuationDependencies,
        onLeaseAcquired: () => {
          signalLeaseReady();
          return leaseBarrier;
        },
      },
    );
    void recovery.catch((error) => {
      trackBoundaryError({
        errorType: "listener_startup_approval_recovery_failed",
        error,
        context: "listener_startup_approval_recovery",
      });
      if (isDebugEnabled()) {
        console.error("[Listen] startup approval recovery failed:", error);
      }
    });
    void recovery.finally(signalLeaseReady).catch(() => {});
    await leaseReady;
    try {
      await replaySubscribedConnectionState(
        listenerRuntime,
        socket,
        syncScopedRuntime,
        scope,
        opts,
      );
    } finally {
      releaseLeaseBarrier();
    }
    (opts?.scheduleWarmupsAfterSync ?? scheduleListenerWarmupsAfterSync)(
      listenerRuntime,
      scope,
    );
    return;
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
