import type { RuntimeScope } from "./runtime-scope";

export interface ExternalToolDefinitionPayload {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RuntimeStartExternalToolsGroup {
  /** Hidden controller-defined scope used to select these tools on input turns. */
  scope_id?: string;
  tools: readonly ExternalToolDefinitionPayload[];
}

/**
 * Applies one external-tool definition set to one or more exact runtimes.
 * Empty external_tools removes the controller's tools for those runtimes.
 */
export interface RuntimeExternalToolsUpdateGroup {
  runtimes: readonly RuntimeScope[];
  external_tools: readonly RuntimeStartExternalToolsGroup[];
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
  runtime?: RuntimeScope;
  scope_id?: string;
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

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
