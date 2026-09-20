import type {
  MonitorStopCommand,
  MonitorStopResponse,
} from "@/types/task-control-protocol";
import { addToMessageQueue } from "@/utils/message-queue-bridge";
import { formatMonitorEventNotification } from "@/utils/task-notifications";
import { kill_bash, killBackgroundProcess } from "./kill-bash";
import {
  type BackgroundRuntimeScope,
  backgroundProcesses,
} from "./process_manager";

/** Stop this conversation's monitors without queuing a turn that undoes the abort. */
export function stopMonitorsForScope(scope: BackgroundRuntimeScope): void {
  for (const [id, process] of backgroundProcesses) {
    if (
      process.kind === "monitor" &&
      process.status === "running" &&
      process.runtimeScope?.agentId === scope.agentId &&
      process.runtimeScope.conversationId === scope.conversationId
    ) {
      killBackgroundProcess(id);
    }
  }
}

export async function stopMonitor(
  command: MonitorStopCommand,
): Promise<MonitorStopResponse> {
  const response: MonitorStopResponse = {
    type: "monitor_stop_response",
    request_id: command.request_id,
    runtime: command.runtime,
    process_id: command.process_id,
    success: false,
    stopped: false,
  };
  const process = backgroundProcesses.get(command.process_id);
  if (!process || process.kind !== "monitor") {
    return { ...response, error: "Monitor not found" };
  }
  if (
    process.runtimeScope?.agentId !== command.runtime.agent_id ||
    process.runtimeScope.conversationId !== command.runtime.conversation_id
  ) {
    return {
      ...response,
      error: "Monitor does not belong to this conversation",
    };
  }
  if (process.status !== "running") return { ...response, success: true };

  const result = await kill_bash({ shell_id: command.process_id });
  if (!result.killed)
    return { ...response, error: "Monitor could not be stopped" };

  addToMessageQueue({
    kind: "task_notification",
    agentId: command.runtime.agent_id,
    conversationId: command.runtime.conversation_id,
    actingUserId: command.runtime.acting_user_id,
    text: formatMonitorEventNotification({
      taskId: command.process_id,
      description: process.description ?? command.process_id,
      event:
        "The user cancelled this Monitor. Do not restart it unless the user asks.",
    }),
  });
  return { ...response, success: true, stopped: true };
}
