import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ToolsetPreference } from "@/tools/toolset";

interface NotificationClientToolsetConfig {
  base?: ToolsetPreference;
  include?: string[];
}

export interface NotificationSponsorshipReference {
  delivery_id: string;
  client_message_id: string;
}

export interface InputCreateNotificationMessagePayload {
  kind: "create_notification_message";
  messages: [MessageCreate & { client_message_id: string }];
  client_message_id: string;
  notification_sponsorship: NotificationSponsorshipReference;
  image_failure_mode?: "strict" | "drop";
  client_tool_allowlist?: string[];
  client_toolset?: NotificationClientToolsetConfig;
  external_tool_scope_ids?: string[];
  exclude_interactive_tools?: boolean;
  response_format?: Record<string, unknown>;
}
