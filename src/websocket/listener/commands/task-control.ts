import type WebSocket from "ws";
import type { LaunchSubagentCommand } from "@/types/subagent-protocol";
import type { MonitorStopCommand } from "@/types/task-control-protocol";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleMonitorStopCommand } from "./monitors";
import { handleLaunchSubagentCommand } from "./subagents";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

export function handleTaskControlCommand(
  command: LaunchSubagentCommand | MonitorStopCommand,
  context: {
    runtime: ListenerRuntime;
    socket: WebSocket;
    connectionId?: string;
    getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
    runDetachedListenerTask: RunDetachedListenerTask;
    safeSocketSend: SafeSocketSend;
  },
): void {
  const {
    runtime,
    socket,
    connectionId,
    getOrCreateScopedRuntime,
    runDetachedListenerTask,
    safeSocketSend,
  } = context;
  runDetachedListenerTask(command.type, async () => {
    const response =
      command.type === "monitor_stop"
        ? await handleMonitorStopCommand(command, runtime)
        : await handleLaunchSubagentCommand(
            command,
            getOrCreateScopedRuntime(
              runtime,
              command.runtime.agent_id,
              command.runtime.conversation_id,
            ),
            connectionId,
          );
    safeSocketSend(socket, response, response.type, command.type);
  });
}
