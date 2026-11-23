import type { AgentRuntimeScope } from "./runtime-scope";

export type BrowserDeviceMcpOAuthErrorCode =
  | "already_connecting"
  | "authorization_failed"
  | "cancelled"
  | "invalid_request";

export interface BrowserDeviceMcpOAuthCommand {
  type: "browser_device_mcp_oauth";
  request_id: string;
  handoff_key: string;
  service: string;
  server_url: string;
  timeout_ms: number;
}

export interface BrowserDeviceMcpOAuthCancelCommand {
  type: "browser_device_mcp_oauth_cancel";
  operation_id: string;
}

export interface BrowserDeviceMcpOAuthResponseMessage {
  type: "browser_device_mcp_oauth_response";
  request_id: string;
  success: boolean;
  error_code?: BrowserDeviceMcpOAuthErrorCode;
}

export interface ExecuteCommandCommand {
  type: "execute_command";
  command_id: string;
  request_id: string;
  runtime: AgentRuntimeScope;
  args?: string;
}

export interface ExecuteCommandResponseMessage {
  type: "execute_command_response";
  request_id: string;
  success: boolean;
  output: string;
}

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
