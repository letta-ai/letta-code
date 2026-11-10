import { confirmProcessExit } from "@/utils/confirm-process-exit";
import { killBackgroundProcess } from "./kill-bash";
import { cancelMonitorBackup } from "./monitor-backup";
import {
  type BackgroundRuntimeScope,
  backgroundProcesses,
} from "./process_manager";

/** Suppress every notification before stopping any producer. */
export async function stopConversationBackground(
  scope: BackgroundRuntimeScope,
): Promise<void> {
  const owned = [...backgroundProcesses].filter(
    ([, process]) =>
      process.runtimeScope?.conversationId === scope.conversationId &&
      (scope.conversationId !== "default" ||
        process.runtimeScope.agentId === scope.agentId),
  );
  for (const [, process] of owned)
    process.completionNotificationSuppressed = true;
  const failures: string[] = [];
  for (const [id, process] of owned) {
    await cancelMonitorBackup(id);
    if (process.status !== "running") continue;
    try {
      if (process.terminate) process.terminate();
      else if (!killBackgroundProcess(id)) throw new Error("Stop failed");
      if (process.completion) await confirmProcessExit(process.completion, id);
      else if (!process.kind)
        throw new Error("Process exit cannot be confirmed");
    } catch {
      failures.push(id);
    }
  }
  if (failures.length)
    throw new Error(`Could not stop background tasks: ${failures.join(", ")}`);
}
