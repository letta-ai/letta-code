import type { GitAttribution } from "./git-attribution";
import type {
  AgentRuntimeScope,
  ConversationRuntimeScope,
} from "./runtime-scope";

export interface SubagentLaunchArgs {
  harness?: string;
  subagent_type?: string;
  fork_context?: boolean;
  prompt: string;
  description: string;
  client_message_id?: string;
  model?: string;
  agent_id?: string;
  conversation_id?: string;
  computer?: string;
  mcp?: {
    inherit: boolean;
    servers?: string[];
  };
  max_turns?: number;
}

export type SubagentLaunchResult =
  | {
      success: true;
      task_id: string;
      output_file: string;
      agent_id: string | null;
      conversation_id: string | null;
    }
  | {
      success: false;
      error: string;
      error_code?: SubagentStartupErrorCode;
    };

export type SubagentStartupErrorCode = "not_installed" | "not_signed_in";

export type SubagentLaunchNotify = "caller";

export type LaunchSubagentWireArgs = SubagentLaunchArgs & {
  cloud_skill_repositories?: string[];
};

export interface LaunchSubagentCommand {
  type: "launch_subagent";
  request_id: string;
  runtime: AgentRuntimeScope;
  args: LaunchSubagentWireArgs;
  git_attribution?: GitAttribution;
  tool_call_id?: string;
  notify?: SubagentLaunchNotify;
}

export type LaunchSubagentResponse = SubagentLaunchResult & {
  type: "launch_subagent_response";
  request_id: string;
  runtime?: AgentRuntimeScope;
};

export interface SubagentMessageCommand {
  type: "subagent_message";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
  message: string;
  git_attribution?: GitAttribution;
  tool_call_id?: string;
}

export type SubagentMessageResponse = {
  type: "subagent_message_response";
  request_id: string;
  runtime?: AgentRuntimeScope;
} & (
  | { success: true; delivery: "steered" | "queued" | "resumed" }
  | { success: false; error: string }
);

export interface SubagentStopCommand {
  conversation?: ConversationRuntimeScope;
  client_message_id?: string;
  type: "subagent_stop";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
}

export interface SubagentStopResponse {
  cleanup_confirmed?: boolean;
  type: "subagent_stop_response";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
  success: boolean;
  stopped: boolean;
  error?: string;
}

export interface SubagentEvents {
  event_seq?: number;
}

export interface SubagentEventRecord {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface ReadSubagentEventsCommand {
  type: "read_subagent_events";
  request_id: string;
  runtime: AgentRuntimeScope;
  subagent_id: string;
  after_seq: number;
  max_bytes?: number;
}

export type ReadSubagentEventsResponse = {
  type: "read_subagent_events_response";
  request_id: string;
  runtime: AgentRuntimeScope;
  subagent_id: string;
} & (
  | {
      success: true;
      events: SubagentEventRecord[];
      next_seq: number;
      has_more: boolean;
      missed: number;
    }
  | { success: false; error: string }
);
