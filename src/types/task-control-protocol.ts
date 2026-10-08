import type { AgentRuntimeScope } from "./runtime-scope";

export type BrowserDeviceMcpOAuthErrorCode =
  | "already_connecting"
  | "authorization_failed"
  | "cancelled"
  | "invalid_request";

/** Start localhost-callback MCP OAuth on this device without an agent turn. */
export interface BrowserDeviceMcpOAuthCommand {
  type: "browser_device_mcp_oauth";
  request_id: string;
  handoff_key: string;
  service: string;
  server_url: string;
}

/** Cancel one in-process browser-device OAuth operation by its start request ID. */
export interface BrowserDeviceMcpOAuthCancelCommand {
  type: "browser_device_mcp_oauth_cancel";
  operation_id: string;
}

/** Credential-free terminal result for a browser-device OAuth start command. */
export interface BrowserDeviceMcpOAuthResponseMessage {
  type: "browser_device_mcp_oauth_response";
  request_id: string;
  success: boolean;
  error_code?: BrowserDeviceMcpOAuthErrorCode;
}

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
