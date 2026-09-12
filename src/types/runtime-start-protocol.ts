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
import type { RuntimeStartExternalToolsGroup } from "./external-tool-protocol";
import type { ConversationRuntimeScope } from "./runtime-scope";

export type DevicePermissionMode =
  | "standard"
  | "acceptEdits"
  | "unrestricted"
  | "strict";

export interface RuntimeStartCommand {
  type: "runtime_start";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Existing agent to start/resume a runtime for. Mutually exclusive with create_agent. */
  agent_id?: string;
  /** Create a new agent before starting the runtime. Mutually exclusive with agent_id. */
  create_agent?: RuntimeStartCreateAgentOptions;
  /** Existing conversation to start/resume. Mutually exclusive with create_conversation. */
  conversation_id?: string;
  /** Create a new conversation. Without an agent, body must provide model and system. */
  create_conversation?: RuntimeStartCreateConversationOptions;
  /** Canonical source tags to merge. Matching legacy summary prefixes are removed. */
  conversation_source_tags?: readonly string[];
  /** Initial working directory for this runtime scope. Null resets to listener boot CWD. */
  cwd?: string | null;
  /** Initial permission mode for this runtime scope. */
  mode?: DevicePermissionMode;
  /** CLI launch options for this conversation. Omission preserves its current options. */
  execution_settings?: RuntimeExecutionSettings;
  workspace_sandbox?: { root: string; isolation_root: string };
  skill_sources?: readonly ("bundled" | "global" | "agent" | "project")[];
  /** Preserve the current override when skill_sources is omitted. */ preserve_skill_sources?: boolean;
  /** Optional client metadata for diagnostics/future protocol negotiation. */
  client_info?: RuntimeStartClientInfo;
  /** Whether to probe backend state for stale pending approvals before replaying state. Defaults to true. */
  recover_approvals?: boolean;
  /** Force the initial state replay to include update_device_status. Defaults to true. */
  force_device_status?: boolean;
  /** Resolve runtime_start only after its initial state replay has been emitted. */
  wait_for_replay?: boolean;
  /** Controller-owned tools registered atomically with the resolved runtime. */
  external_tools?: readonly RuntimeStartExternalToolsGroup[];
}

export interface RuntimeStartResponseMessage {
  type: "runtime_start_response";
  request_id: string;
  success: boolean;
  runtime: ConversationRuntimeScope | null;
  agent: AgentState | null;
  conversation: Conversation | null;
  /** Echoed only when this listener applied the requested execution options. */
  execution_settings?: RuntimeExecutionSettings;
  created: { agent: boolean; conversation: boolean };
  error?: string;
}

export interface RuntimeStartCreateAgentOptions {
  /** Body forwarded to the Letta agents create API. */
  body: AgentCreateParams;
  /** Whether to pin the created agent globally. Defaults to true. */
  pin_global?: boolean;
  /** Disable for worker-style agents whose memory scope is provided per session. */
  memfs?: boolean;
}

export interface RuntimeStartCreateConversationOptions {
  /** Agent-backed create body, or an agent-free model and system prompt when no agent is supplied. */
  body?:
    | Omit<ConversationCreateParams, "agent_id">
    | EphemeralConversationCreateBody;
}

export interface RuntimeStartClientInfo {
  name: string;
  title?: string;
  version?: string;
}
