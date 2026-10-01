import type { AgentRuntimeScope } from "./runtime-scope";

/** Run a slash command in an agent conversation. */
export interface ExecuteCommandCommand {
  type: "execute_command";
  command_id: string;
  request_id: string;
  runtime: AgentRuntimeScope;
  /** Everything after the command name. */
  args?: string;
}

export interface ExecuteCommandResponseMessage {
  type: "execute_command_response";
  request_id: string;
  success: boolean;
  output: string;
}

/** Remove a queued input without stopping the active turn. */
export interface RemoveQueueItemCommand {
  type: "remove_queue_item";
  request_id: string;
  runtime: AgentRuntimeScope;
  item_id: string;
}

export interface RemoveQueueItemResponse {
  type: "remove_queue_item_response";
  request_id: string;
  success: boolean;
  item_id: string;
}

export interface MonitorStopCommand {
  type: "monitor_stop";
  request_id: string;
  runtime: AgentRuntimeScope;
  process_id: string;
}

export interface MonitorStopResponse {
  type: "monitor_stop_response";
  request_id: string;
  runtime: AgentRuntimeScope;
  process_id: string;
  success: boolean;
  stopped: boolean;
  error?: string;
}
