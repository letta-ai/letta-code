import type {
  AgentCreateParams,
  AgentState,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Conversation,
  ConversationCreateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type { EphemeralConversationCreateBody } from "@/backend/api/ephemeral-conversations";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import type {
  RuntimeStartExternalToolsGroup,
  RuntimeToolPolicy,
} from "./external-tool-protocol";
import type { ConversationRuntimeScope } from "./runtime-scope";

export type DevicePermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted"
  | "strict";

export interface RuntimeStartCommand {
  type: "runtime_start";
  request_id: string;
  agent_id?: string;
  create_agent?: RuntimeStartCreateAgentOptions;
  conversation_id?: string;
  create_conversation?: RuntimeStartCreateConversationOptions;
  conversation_source_tags?: readonly string[];
  cwd?: string | null;
  mode?: DevicePermissionMode;
  mode_is_default?: boolean;
  execution_settings?: RuntimeExecutionSettings;
  workspace_sandbox?: { root: string; isolation_root: string };
  skill_sources?: readonly ("bundled" | "global" | "agent" | "project")[];
  preserve_skill_sources?: boolean;
  bundled_skills?: readonly string[];
  client_info?: RuntimeStartClientInfo;
  recover_approvals?: boolean;
  force_device_status?: boolean;
  wait_for_replay?: boolean;
  teleport_id?: string;
  external_tools?: readonly RuntimeStartExternalToolsGroup[];
  tool_policy?: RuntimeToolPolicy;
}

export interface RuntimeStartResponseMessage {
  type: "runtime_start_response";
  request_id: string;
  success: boolean;
  runtime: ConversationRuntimeScope | null;
  agent: AgentState | null;
  conversation: Conversation | null;
  execution_settings?: RuntimeExecutionSettings;
  created: { agent: boolean; conversation: boolean };
  error?: string;
}

export interface RuntimeStartCreateAgentOptions {
  body: AgentCreateParams;
  pin_global?: boolean;
  memfs?: boolean;
}

export interface RuntimeStartCreateConversationOptions {
  body?:
    | Omit<ConversationCreateParams, "agent_id">
    | EphemeralConversationCreateBody;
}

export interface RuntimeStartClientInfo {
  name: string;
  title?: string;
  version?: string;
}
