import type { RuntimeScope } from "./runtime-scope";
import type { ToolsetPreference } from "./toolset-protocol";

export interface ExternalToolDefinitionPayload {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  timeout_ms?: number;
  auto_background?: boolean;
}

export interface RuntimeStartExternalToolsGroup {
  tools: readonly ExternalToolDefinitionPayload[];
  capabilities?: { external_tool_call_cancel?: boolean };
}

export interface RuntimeExternalToolsUpdateGroup {
  runtimes: readonly RuntimeScope<string | null>[];
  external_tools: readonly RuntimeStartExternalToolsGroup[];
  tool_policy?: RuntimeToolPolicy;
}

export interface RuntimeExternalToolsUpdateCommand {
  type: "runtime_external_tools_update";
  request_id: string;
  updates: readonly RuntimeExternalToolsUpdateGroup[];
}

export interface RuntimeExternalToolsUpdateResponseMessage {
  type: "runtime_external_tools_update_response";
  request_id: string;
  success: boolean;
  error?: string;
}

export interface ExternalToolCallRequestMessage {
  type: "external_tool_call_request";
  request_id: string;
  runtime?: RuntimeScope<string | null>;
  turn_started_at?: number;
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ExternalToolCallCancelMessage {
  type: "external_tool_call_cancel";
  request_id: string;
  reason?: string;
}

export type ExternalToolCallMessage =
  | ExternalToolCallRequestMessage
  | ExternalToolCallCancelMessage;

export interface ExternalToolCallResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ExternalToolCallResult {
  content: readonly ExternalToolCallResultContent[];
  is_error?: boolean;
}

export interface ExternalToolCallResponseCommand {
  type: "external_tool_call_response";
  request_id: string;
  result?: ExternalToolCallResult;
  error?: string;
}

export interface RuntimeToolPolicy {
  toolset?: { base?: ToolsetPreference; include?: readonly string[] };
  allowlist?: readonly string[];
  exclude_interactive?: boolean;
  foreground_yield_ms?: number;
}
