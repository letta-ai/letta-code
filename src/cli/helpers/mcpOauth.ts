/**
 * MCP OAuth SSE client for connecting to MCP servers that require OAuth authentication.
 * Uses the /v1/tools/mcp/servers/connect SSE streaming endpoint.
 */

import { getServerUrl } from "../../agent/client";
import { getMcpOAuthHeaders } from "../../agent/http-headers";
import { settingsManager } from "../../settings-manager";

// Match backend's OauthStreamEvent enum
export enum OauthStreamEvent {
  CONNECTION_ATTEMPT = "connection_attempt",
  SUCCESS = "success",
  ERROR = "error",
  OAUTH_REQUIRED = "oauth_required",
  AUTHORIZATION_URL = "authorization_url",
  WAITING_FOR_AUTH = "waiting_for_auth",
}

export interface McpOauthEvent {
  event: OauthStreamEvent;
  url?: string; // For AUTHORIZATION_URL
  session_id?: string; // For tracking
  tools?: McpTool[]; // For SUCCESS
  message?: string; // For ERROR/info
  server_name?: string; // Server name
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpConnectConfig {
  server_name: string;
  type: "sse" | "streamable_http";
  server_url: string;
  auth_header?: string;
  auth_token?: string;
  custom_headers?: Record<string, string>;
}

export interface McpConnectOptions {
  onEvent?: (event: McpOauthEvent) => void;
  abortSignal?: AbortSignal;
}

/**
 * Connect to an MCP server with OAuth support via SSE streaming.
 * Returns the list of available tools on success.
 *
 * The flow:
 * 1. Opens SSE stream to /v1/tools/mcp/servers/connect
 * 2. Receives CONNECTION_ATTEMPT event
 * 3. If OAuth is required:
 *    - Receives OAUTH_REQUIRED event
 *    - Receives AUTHORIZATION_URL event with OAuth URL
 *    - Receives WAITING_FOR_AUTH event
 *    - Caller should open browser with the URL
 *    - After user authorizes, receives SUCCESS event
 * 4. Returns tools array on SUCCESS, throws on ERROR
 */
export async function connectMcpServer(
  config: McpConnectConfig,
  options: McpConnectOptions = {},
): Promise<McpTool[]> {
  const { onEvent, abortSignal } = options;

  const settings = await settingsManager.getSettingsWithSecureTokens();
  const baseUrl = getServerUrl();
  const apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!apiKey) {
    throw new Error("Missing LETTA_API_KEY");
  }

  const response = await fetch(`${baseUrl}/v1/tools/mcp/servers/connect`, {
    method: "POST",
    headers: getMcpOAuthHeaders(apiKey),
    body: JSON.stringify(config),
    signal: abortSignal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Connection failed (${response.status}): ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Failed to get response stream reader");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error("Stream ended unexpectedly without success or error");
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || line.trim() === "[DONE]") continue;

        let data = line;
        if (line.startsWith("data: ")) {
          data = line.slice(6);
        }

        if (data.trim() === "[DONE]") continue;

        try {
          const event = JSON.parse(data) as McpOauthEvent;
          onEvent?.(event);

          switch (event.event) {
            case OauthStreamEvent.SUCCESS:
              return event.tools || [];

            case OauthStreamEvent.ERROR:
              throw new Error(event.message || "Connection failed");

            case OauthStreamEvent.AUTHORIZATION_URL:
              // Event handler should open browser
              // Continue processing stream for WAITING_FOR_AUTH and SUCCESS
              break;

            // Other events are informational (CONNECTION_ATTEMPT, OAUTH_REQUIRED, WAITING_FOR_AUTH)
          }
        } catch (parseError) {
          // Skip unparseable lines (might be partial SSE data)
          if (parseError instanceof SyntaxError) continue;
          throw parseError;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
