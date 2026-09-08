import type { MonitorCancellationReceipt } from "@/tools/impl/monitor-cancellation-store";
import {
  acquireManualListenerLock,
  ManualListenerAlreadyRunningError,
  type ManualListenerLockHandle,
} from "./manual-instance-lock";

export type MonitorCancellationOwner = ManualListenerLockHandle;

export function isCancellationOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors are not evidence that another listener has exited.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function acquireMonitorCancellationOwner(
  directory: string,
  receipt: MonitorCancellationReceipt,
): Promise<MonitorCancellationOwner | null> {
  try {
    return await acquireManualListenerLock(
      {
        serverUrl: "monitor-cancellation",
        deviceId: receipt.runtime.agent_id,
        listenerInstanceId: `${receipt.runtime.conversation_id}:${receipt.processId}`,
      },
      { lockRoot: directory },
    );
  } catch (error) {
    if (error instanceof ManualListenerAlreadyRunningError) return null;
    throw error;
  }
}
