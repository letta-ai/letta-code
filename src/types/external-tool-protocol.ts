import type { RuntimeScope } from "./runtime-scope";
import type { ToolsetPreference } from "./toolset-protocol";

export interface ExternalToolDefinitionPayload {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Controller-requested wait for a result; expiry does not cancel remote work. */
  timeout_ms?: number;
  /** Yield to a scoped task notification after 10s by default; false waits inline. */
  auto_background?: boolean;
}

/**
 * Tools a connection registers for a conversation. While the connection is
 * open they are visible to every turn on that conversation; calls run through
 * the registering connection.
 */
export interface RuntimeStartExternalToolsGroup {
  tools: readonly ExternalToolDefinitionPayload[];
  capabilities?: { external_tool_call_cancel?: boolean };
}

/**
 * Applies one external-tool definition set to one or more exact runtimes.
 * Empty external_tools removes the controller's tools for those runtimes.
 * Omitting tool_policy clears the controller's policy for those runtimes.
 */
export interface RuntimeExternalToolsUpdateGroup {
  runtimes: readonly RuntimeScope<string | null>[];
  external_tools: readonly RuntimeStartExternalToolsGroup[];
  tool_policy?: RuntimeToolPolicy;
}

/**
 * Publishes runtime-owned external tools without starting or subscribing to
 * each runtime. Registrations remain owned by the sending connection.
 */
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

/**
 * Connection-level tool selection for one conversation. It lives as long as
 * the connection's external-tool registration for that conversation and
 * applies to every turn there, including turns the process starts (task
 * notifications, cron prompts, recovery). Per-input fields override it for
 * their own turn only; a per-input allowlist can only narrow this allowlist.
 */
export interface RuntimeToolPolicy {
  /** Base toolset and extra bundled tools; same meaning as `client_toolset`. */
  toolset?: { base?: ToolsetPreference; include?: readonly string[] };
  /** Exact tool allowlist; same meaning as `client_tool_allowlist`. */
  allowlist?: readonly string[];
  /** Same meaning as `exclude_interactive_tools`. */
  exclude_interactive?: boolean;
  /**
   * Milliseconds to wait before a long-running Bash, CodeMode, exec_command or
   * external tool call is returned as a background task. Clamped to 1–30s;
   * defaults to 10s when omitted.
   */
  foreground_yield_ms?: number;
}
