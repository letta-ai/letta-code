import type { AgentRuntimeScope } from "./runtime-scope";

/** The public launch arguments shared by Agent and App Server clients. */
export interface SubagentLaunchArgs {
  /** `letta` (default), an external worker type, or a named Letta subagent. */
  agent_type?: string;
  /** Start the child with the parent conversation's context. */
  fork_context?: boolean;
  /** Deprecated alias for `agent_type` (`fork` = letta + fork_context). */
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

export interface SubagentMessageCommand {
  type: "subagent_message";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
  message: string;
  tool_call_id?: string;
}

export type SubagentMessageResponse = {
  type: "subagent_message_response";
  request_id: string;
  runtime?: AgentRuntimeScope;
} & (
  | { success: true; delivery: "steered" | "resumed" }
  | { success: false; error: string }
);

export interface SubagentStopCommand {
  type: "subagent_stop";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
}

export interface SubagentStopResponse {
  type: "subagent_stop_response";
  request_id: string;
  runtime: AgentRuntimeScope;
  agent_id: string;
  success: boolean;
  stopped: boolean;
  error?: string;
}

/** Event-log fields of a subagent snapshot. */
export interface SubagentEvents {
  /** Latest event seq; present when `read_subagent_events` can read them. */
  event_seq?: number;
}

/** One entry of a subagent task's event log. */
export interface SubagentEventRecord {
  /** 1-based, increasing per subagent. */
  seq: number;
  /** ISO timestamp of when the worker produced the event. */
  at: string;
  /** `tool_call`, `tool_result`, `text`, `reasoning`, or `notification`. */
  type: string;
  [key: string]: unknown;
}

/**
 * Read a caller-notified subagent's events after `after_seq`. Snapshots carry
 * `event_seq` (the latest seq) when the computer supports this command.
 */
export interface ReadSubagentEventsCommand {
  type: "read_subagent_events";
  request_id: string;
  /** The launching parent conversation. */
  runtime: AgentRuntimeScope;
  /** `subagent_id` from the subagent's snapshot. */
  subagent_id: string;
  after_seq: number;
  /** Page budget; the computer caps it. */
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
      /** Oldest first. An oversized event is cut, ending in `[truncated N bytes]`. */
      events: SubagentEventRecord[];
      /** Pass as `after_seq` for the next page. */
      next_seq: number;
      has_more: boolean;
      /** Events after `after_seq` the computer no longer keeps. */
      missed: number;
    }
  | { success: false; error: string }
);
