import type WebSocket from "ws";
import type { ConversationRuntimeScope } from "@/types/runtime-scope";
import type {
  LaunchSubagentCommand,
  ReadSubagentEventsCommand,
  SubagentMessageCommand,
  SubagentStopCommand,
} from "@/types/subagent-protocol";
import type { MonitorStopCommand } from "@/types/task-control-protocol";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleMonitorStopCommand } from "./monitors";
import { stopListenerConversation } from "./stop-conversation";
import {
  handleSubagentMessageCommand,
  handleSubagentStopCommand,
} from "./subagent-control";
import { handleReadSubagentEventsCommand } from "./subagent-events";
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
    | ReadSubagentEventsCommand
    | SubagentMessageCommand
    | SubagentStopCommand,
  context: {
    runtime: ListenerRuntime;
    abortConversation?: (scope: ConversationRuntimeScope) => Promise<boolean>;
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
    if (command.type === "subagent_stop" && command.conversation) {
      const response = await stopListenerConversation(
        command,
        context.abortConversation ??
          (async () => {
            throw new Error("Listener cancellation is unavailable");
          }),
      );
      safeSocketSend(socket, response, response.type, command.type);
      return;
    }
    if (command.type === "monitor_stop") {
      const response = await handleMonitorStopCommand(command, runtime);
      safeSocketSend(socket, response, response.type, command.type);
      return;
    }
    if (command.type === "read_subagent_events") {
      const response = handleReadSubagentEventsCommand(command);
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
