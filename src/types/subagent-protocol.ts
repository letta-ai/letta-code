import type { AgentRuntimeScope } from "./runtime-scope";

/** The public launch arguments shared by Agent and App Server clients. */
export interface SubagentLaunchArgs {
  subagent_type?: string;
  prompt: string;
  description: string;
  /** Identity of the initial assignment input, not the launch command request_id. */
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
      /** Why a claude-code/codex worker could not start on this computer. */
      error_code?: SubagentStartupErrorCode;
    };

export type SubagentStartupErrorCode = "not_installed" | "not_signed_in";

/**
 * `caller`: the launching client owns the completion notification. The
 * computer skips its own notification and publishes the final report as
 * `result` on the `update_subagent_state` snapshot.
 */
export type SubagentLaunchNotify = "caller";

export interface LaunchSubagentCommand {
  type: "launch_subagent";
  request_id: string;
  /** Parent conversation, used for launch context and completion notifications. */
  runtime: AgentRuntimeScope;
  args: SubagentLaunchArgs;
  /** The originating Agent or external-tool call, when present. */
  tool_call_id?: string;
  /** Requires the `launch_subagent_notify_caller` capability. */
  notify?: SubagentLaunchNotify;
}

export type LaunchSubagentResponse = SubagentLaunchResult & {
  type: "launch_subagent_response";
  request_id: string;
  /** The launch command's parent runtime, so relays can scope the reply. */
  runtime?: AgentRuntimeScope;
};
