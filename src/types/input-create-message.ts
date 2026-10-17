/**
 * The controller -> execution-environment `create_message` input payload and
 * its request-scoped toolset selection. Split out of protocol_v2.ts to keep
 * that file under the source-size limit; protocol_v2 re-exports both types.
 */
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ClientPreferences } from "./client-preferences";
import type { ToolsetPreference } from "./toolset-protocol";

export interface ClientToolsetConfig {
  /** Request-scoped base toolset. Omitted preserves the runtime preference. */
  base?: ToolsetPreference;
  /** Additional bundled client tools to load before applying the allowlist. */
  include?: string[];
}

export interface InputCreateMessagePayload {
  kind: "create_message";
  /** Omitted inherits; supplied replaces the conversation snapshot; {} clears. */
  client_preferences?: ClientPreferences;
  messages: Array<MessageCreate & { client_message_id?: string }>;
  /** Handling policy for unsupported or failed image inputs. */
  image_failure_mode?: "strict" | "drop";
  /**
   * Optional request-scoped allowlist for locally executed client tools.
   * Undefined preserves the listener's normal toolset; an empty array means no
   * client tools for this turn.
   */
  client_tool_allowlist?: string[];
  /**
   * Optional request-scoped built-in toolset selection. The base chooses the
   * harness preset without changing persisted settings; include adds bundled
   * client tools before the allowlist is applied.
   */
  client_toolset?: ClientToolsetConfig;
  /** Scoped runtime-start tools to expose for this turn; unscoped tools remain available. */
  external_tool_scope_ids?: string[];
  /** Exclude interactive tools even when included by preferences or this input. */
  exclude_interactive_tools?: boolean;
  response_format?: Record<string, unknown>;
}
