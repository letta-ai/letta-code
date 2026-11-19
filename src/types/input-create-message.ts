import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ClientPreferences } from "./client-preferences";
import type { GitAttribution } from "./git-attribution";
import type { ToolsetPreference } from "./toolset-protocol";

export interface ClientToolsetConfig {
  base?: ToolsetPreference;
  include?: string[];
}

export interface InputCreateMessagePayload {
  kind: "create_message";
  git_attribution?: GitAttribution;
  client_preferences?: ClientPreferences;
  messages: Array<MessageCreate & { client_message_id?: string }>;
  image_failure_mode?: "strict" | "drop";
  client_tool_allowlist?: string[];
  client_toolset?: ClientToolsetConfig;
  exclude_interactive_tools?: boolean;
  response_format?: Record<string, unknown>;
}
