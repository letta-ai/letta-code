/**
 * Direct Anthropic API client for Claude Max subscription usage
 *
 * This client bypasses the Letta platform and makes direct calls to Anthropic's API
 * using OAuth tokens from a Claude Pro/Max subscription.
 */

import {
  ANTHROPIC_OAUTH_CONFIG,
  refreshAnthropicToken,
} from "../auth/anthropic-oauth";
import { settingsManager } from "../settings-manager";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "tool"; name?: string };
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  metadata?: { user_id?: string };
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicStreamEvent {
  type:
    | "message_start"
    | "content_block_start"
    | "content_block_delta"
    | "content_block_stop"
    | "message_delta"
    | "message_stop"
    | "ping"
    | "error";
  message?: AnthropicMessagesResponse;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage?: AnthropicUsage;
  error?: { type: string; message: string };
}

/**
 * Get valid Anthropic credentials, refreshing if needed
 */
async function getValidCredentials(): Promise<string> {
  const settings = settingsManager.getSettings();

  if (!settings.anthropicAccessToken || !settings.anthropicRefreshToken) {
    throw new Error(
      "Anthropic credentials not found. Run 'letta login anthropic' to authenticate.",
    );
  }

  const now = Date.now();
  const expiresAt = settings.anthropicTokenExpiresAt || 0;

  // Refresh if token expires within 5 minutes
  if (expiresAt - now < 5 * 60 * 1000) {
    console.log("Refreshing Anthropic access token...");
    try {
      const newCredentials = await refreshAnthropicToken(
        settings.anthropicRefreshToken,
      );

      settingsManager.updateSettings({
        anthropicAccessToken: newCredentials.accessToken,
        anthropicRefreshToken: newCredentials.refreshToken,
        anthropicTokenExpiresAt: newCredentials.expiresAt,
      });

      return newCredentials.accessToken;
    } catch (error) {
      throw new Error(
        `Failed to refresh Anthropic token: ${error instanceof Error ? error.message : String(error)}. Run 'letta login anthropic' to re-authenticate.`,
      );
    }
  }

  return settings.anthropicAccessToken;
}

/**
 * Make an authenticated request to Anthropic API
 */
async function anthropicRequest<T>(
  endpoint: string,
  body: unknown,
  stream = false,
): Promise<T | ReadableStream<Uint8Array>> {
  const accessToken = await getValidCredentials();

  const response = await fetch(
    `${ANTHROPIC_OAUTH_CONFIG.apiBaseUrl}${endpoint}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  if (stream && response.body) {
    return response.body as ReadableStream<Uint8Array>;
  }

  return (await response.json()) as T;
}

/**
 * Send a message to Claude using direct Anthropic API
 */
export async function sendAnthropicMessage(
  request: AnthropicMessagesRequest,
): Promise<AnthropicMessagesResponse> {
  const result = await anthropicRequest<AnthropicMessagesResponse>(
    "/v1/messages",
    { ...request, stream: false },
    false,
  );
  return result as AnthropicMessagesResponse;
}

/**
 * Send a streaming message to Claude using direct Anthropic API
 */
export async function sendAnthropicMessageStream(
  request: AnthropicMessagesRequest,
): Promise<ReadableStream<Uint8Array>> {
  return anthropicRequest<ReadableStream<Uint8Array>>(
    "/v1/messages",
    { ...request, stream: true },
    true,
  ) as Promise<ReadableStream<Uint8Array>>;
}

/**
 * Parse SSE stream events from Anthropic API
 */
export async function* parseAnthropicStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            yield JSON.parse(data) as AnthropicStreamEvent;
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Check if Anthropic direct mode is available and configured
 */
export function isAnthropicDirectModeAvailable(): boolean {
  try {
    const settings = settingsManager.getSettings();
    return !!(settings.anthropicAccessToken && settings.anthropicRefreshToken);
  } catch {
    return false;
  }
}

/**
 * Check if Anthropic direct mode is the preferred backend
 */
export function isAnthropicPreferred(): boolean {
  try {
    const settings = settingsManager.getSettings();
    return settings.preferredBackend === "anthropic";
  } catch {
    return false;
  }
}

/**
 * Available Claude models for direct API access
 */
export const ANTHROPIC_MODELS = [
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    description: "Most capable model for complex tasks",
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    description: "Balanced performance and speed",
  },
  {
    id: "claude-3-5-sonnet-20241022",
    name: "Claude 3.5 Sonnet",
    description: "Previous generation, fast and capable",
  },
  {
    id: "claude-3-5-haiku-20241022",
    name: "Claude 3.5 Haiku",
    description: "Fastest model for simple tasks",
  },
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number]["id"];

/**
 * Get the default Anthropic model
 */
export function getDefaultAnthropicModel(): AnthropicModelId {
  return "claude-sonnet-4-20250514";
}
