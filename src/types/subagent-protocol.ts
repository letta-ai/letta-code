import type { AgentRuntimeScope } from "./runtime-scope";

/** The public launch arguments shared by Agent and App Server clients. */
export interface SubagentLaunchArgs {
  subagent_type?: string;
  prompt: string;
  description: string;
  /** Identity of the initial assignment input, not the launch command request_id. */
  client_message_id?: string;
  model?: string;
  /** Reasoning effort, chosen independently of the model ID. */
  reasoning_effort?: string;
  agent_id?: string;
  conversation_id?: string;
  computer?: string;
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
  | { success: false; error: string };

export interface LaunchSubagentCommand {
  type: "launch_subagent";
  request_id: string;
  /** Parent conversation, used for launch context and completion notifications. */
  runtime: AgentRuntimeScope;
  args: SubagentLaunchArgs;
  /** The originating Agent or external-tool call, when present. */
  tool_call_id?: string;
}

export type LaunchSubagentResponse = SubagentLaunchResult & {
  type: "launch_subagent_response";
  request_id: string;
};
