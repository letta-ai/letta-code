import type WebSocket from "ws";
import type {
  LaunchSubagentCommand,
  SubagentMessageCommand,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import type { MonitorStopCommand } from "@/types/task-control-protocol";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleMonitorStopCommand } from "./monitors";
import {
  handleSubagentMessageCommand,
  handleSubagentStopCommand,
} from "./subagent-control";
import { handleLaunchSubagentCommand } from "./subagents";
import type {
  GetOrCreateScopedRuntime,
  RunDetachedListenerTask,
  SafeSocketSend,
} from "./types";

export async function handleTaskControlCommand(
  command:
    | LaunchSubagentCommand
    | MonitorStopCommand
    | SubagentMessageCommand
    | SubagentStopCommand,
  context: {
    runtime: ListenerRuntime;
    socket: WebSocket;
    connectionId?: string;
    getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
    runDetachedListenerTask: RunDetachedListenerTask;
    safeSocketSend: SafeSocketSend;
  },
): Promise<void> {
  const {
    runtime,
    socket,
    connectionId,
    getOrCreateScopedRuntime,
    runDetachedListenerTask,
    safeSocketSend,
  } = context;
  const execute = async () => {
    if (command.type === "monitor_stop") {
      const response = await handleMonitorStopCommand(command, runtime);
      safeSocketSend(socket, response, response.type, command.type);
      return;
    }
    const parent = getOrCreateScopedRuntime(
      runtime,
      command.runtime.agent_id,
      command.runtime.conversation_id,
    );
    const response =
      command.type === "launch_subagent"
        ? await handleLaunchSubagentCommand(command, parent, connectionId)
        : command.type === "subagent_message"
          ? await handleSubagentMessageCommand(command, parent)
          : await handleSubagentStopCommand(command, parent);
    safeSocketSend(socket, response, response.type, command.type);
  };
  if (
    command.type === "launch_subagent" ||
    command.type === "subagent_message"
  ) {
    runDetachedListenerTask(command.type, execute);
  } else {
    await execute();
  }
}
