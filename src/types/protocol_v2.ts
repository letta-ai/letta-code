/**
 * Protocol V2 (alpha hard-cut contract)
 *
 * This file defines the runtime-scoped websocket contract for device-mode UIs.
 * It is intentionally self-defined and does not import transport/event shapes
 * from the legacy protocol.ts surface.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";

/**
 * Runtime identity for all state and delta events.
 */
export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

/**
 * Base envelope shared by all v2 websocket messages.
 */
export interface RuntimeEnvelope {
  runtime: RuntimeScope;
  event_seq: number;
  emitted_at: string;
  idempotency_key: string;
}

export type DevicePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions";

export type ToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";

export type ToolsetPreference = ToolsetName | "auto";

export interface AvailableSkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: "bundled" | "global" | "agent" | "project";
}

export interface BashBackgroundProcessSummary {
  process_id: string;
  kind: "bash";
  command: string;
  started_at_ms: number | null;
  status: string;
  exit_code: number | null;
}

export interface AgentTaskBackgroundProcessSummary {
  process_id: string;
  kind: "agent_task";
  task_type: string;
  description: string;
  started_at_ms: number;
  status: string;
  subagent_id: string | null;
  error?: string;
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary;

export interface DiffHunkLine {
  type: "context" | "add" | "remove";
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export type DiffPreview =
  | { mode: "advanced"; fileName: string; hunks: DiffHunk[] }
  | { mode: "fallback"; fileName: string; reason: string }
  | { mode: "unpreviewable"; fileName: string; reason: string };

export interface CanUseToolControlRequestBody {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_call_id: string;
  permission_suggestions: string[];
  blocked_path: string | null;
  diffs?: DiffPreview[];
}

export type ControlRequestBody = CanUseToolControlRequestBody;

export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
  agent_id?: string;
  conversation_id?: string;
}

export interface PendingControlRequest {
  request_id: string;
  request: ControlRequestBody;
}

/**
 * Bottom-bar and device execution context state.
 */
export interface DeviceStatus {
  current_connection_id: string | null;
  connection_name: string | null;
  is_online: boolean;
  is_processing: boolean;
  current_permission_mode: DevicePermissionMode;
  current_working_directory: string | null;
  letta_code_version: string | null;
  current_toolset: ToolsetName | null;
  current_toolset_preference: ToolsetPreference;
  current_loaded_tools: string[];
  current_available_skills: AvailableSkillSummary[];
  background_processes: BackgroundProcessSummary[];
  pending_control_requests: PendingControlRequest[];
  memory_directory: string | null;
}

export type LoopStatus =
  | "SENDING_API_REQUEST"
  | "WAITING_FOR_API_RESPONSE"
  | "RETRYING_API_REQUEST"
  | "PROCESSING_API_RESPONSE"
  | "EXECUTING_CLIENT_SIDE_TOOL"
  | "EXECUTING_COMMAND"
  | "WAITING_ON_APPROVAL"
  | "WAITING_ON_INPUT";

export type QueueMessageKind =
  | "message"
  | "task_notification"
  | "cron_prompt"
  | "approval_result"
  | "overlay_action";

export type QueueMessageSource =
  | "user"
  | "task_notification"
  | "cron"
  | "subagent"
  | "system";

export interface QueueMessage {
  id: string;
  client_message_id: string;
  kind: QueueMessageKind;
  source: QueueMessageSource;
  content: MessageCreate["content"] | string;
  enqueued_at: string;
}

/**
 * Loop state is intentionally small and finite.
 * Message-level details are projected from runtime deltas.
 *
 * Queue state is delivered separately via `update_queue` messages.
 */
export interface LoopState {
  status: LoopStatus;
  active_run_ids: string[];
}

export interface DeviceStatusUpdateMessage extends RuntimeEnvelope {
  type: "update_device_status";
  device_status: DeviceStatus;
}

export interface LoopStatusUpdateMessage extends RuntimeEnvelope {
  type: "update_loop_status";
  loop_status: LoopState;
}

/**
 * Full snapshot of the turn queue.
 * Emitted on every queue mutation (enqueue, dequeue, clear, drop).
 * Queue is typically 0-5 items so full snapshot is cheap and idempotent.
 */
export interface QueueUpdateMessage extends RuntimeEnvelope {
  type: "update_queue";
  queue: QueueMessage[];
}

/**
 * Standard Letta message delta forwarded through the stream channel.
 */
export type MessageDelta = { type: "message" } & LettaStreamingResponse;

export interface UmiLifecycleMessageBase {
  id: string;
  date: string;
  message_type: string;
  run_id?: string;
}

export interface ClientToolStartMessage extends UmiLifecycleMessageBase {
  message_type: "client_tool_start";
  tool_call_id: string;
}

export interface ClientToolEndMessage extends UmiLifecycleMessageBase {
  message_type: "client_tool_end";
  tool_call_id: string;
  status: "success" | "error";
}

export interface CommandStartMessage extends UmiLifecycleMessageBase {
  message_type: "command_start";
  command_id: string;
  input: string;
}

export interface CommandEndMessage extends UmiLifecycleMessageBase {
  message_type: "command_end";
  command_id: string;
  input: string;
  output: string;
  success: boolean;
  dim_output?: boolean;
  preformatted?: boolean;
}

export interface StatusMessage extends UmiLifecycleMessageBase {
  message_type: "status";
  message: string;
  level: "info" | "success" | "warning";
}

export interface RetryMessage extends UmiLifecycleMessageBase {
  message_type: "retry";
  message: string;
  reason: StopReasonType;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
}

export interface LoopErrorMessage extends UmiLifecycleMessageBase {
  message_type: "loop_error";
  message: string;
  stop_reason: StopReasonType;
  is_terminal: boolean;
  api_error?: LettaStreamingResponse.LettaErrorMessage;
}

/**
 * Expanded message-delta union.
 * stream_delta is the only message stream event the WS server emits in v2.
 */
export type StreamDelta =
  | MessageDelta
  | ClientToolStartMessage
  | ClientToolEndMessage
  | CommandStartMessage
  | CommandEndMessage
  | StatusMessage
  | RetryMessage
  | LoopErrorMessage;

export interface StreamDeltaMessage extends RuntimeEnvelope {
  type: "stream_delta";
  delta: StreamDelta;
  subagent_id?: string;
}

/**
 * Subagent state snapshot.
 * Emitted via `update_subagent_state` on every subagent mutation.
 */
export interface SubagentSnapshotToolCall {
  id: string;
  name: string;
  args: string;
}

export interface SubagentSnapshot {
  subagent_id: string;
  subagent_type: string;
  description: string;
  status: "pending" | "running" | "completed" | "error";
  agent_url: string | null;
  model?: string;
  is_background?: boolean;
  silent?: boolean;
  tool_call_id?: string;
  start_time: number;
  tool_calls: SubagentSnapshotToolCall[];
  total_tokens: number;
  duration_ms: number;
  error?: string;
}

export interface SubagentStateUpdateMessage extends RuntimeEnvelope {
  type: "update_subagent_state";
  subagents: SubagentSnapshot[];
}

export interface ApprovalResponseAllowDecision {
  behavior: "allow";
  message?: string;
  updated_input?: Record<string, unknown> | null;
  updated_permissions?: string[];
}

export interface ApprovalResponseDenyDecision {
  behavior: "deny";
  message: string;
}

export type ApprovalResponseDecision =
  | ApprovalResponseAllowDecision
  | ApprovalResponseDenyDecision;

export type ApprovalResponseBody =
  | {
      request_id: string;
      decision: ApprovalResponseDecision;
    }
  | {
      request_id: string;
      error: string;
    };

/**
 * Controller -> execution-environment commands.
 * In v2, the WS server accepts only:
 * - input (chat-loop ingress envelope)
 * - change_device_state (device runtime mutation)
 * - abort_message (abort request)
 */
export interface InputCreateMessagePayload {
  kind: "create_message";
  messages: Array<MessageCreate & { client_message_id?: string }>;
}

export type InputApprovalResponsePayload = {
  kind: "approval_response";
} & ApprovalResponseBody;

export type InputPayload =
  | InputCreateMessagePayload
  | InputApprovalResponsePayload;

export interface InputCommand {
  type: "input";
  runtime: RuntimeScope;
  payload: InputPayload;
}

export interface ChangeDeviceStatePayload {
  mode?: DevicePermissionMode;
  cwd?: string;
  agent_id?: string | null;
  conversation_id?: string | null;
}

export interface ChangeDeviceStateCommand {
  type: "change_device_state";
  runtime: RuntimeScope;
  payload: ChangeDeviceStatePayload;
}

export interface AbortMessageCommand {
  type: "abort_message";
  runtime: RuntimeScope;
  request_id?: string;
  run_id?: string | null;
}

export interface SyncCommand {
  type: "sync";
  runtime: RuntimeScope;
}

export interface TerminalSpawnCommand {
  type: "terminal_spawn";
  terminal_id: string;
  cols: number;
  rows: number;
  /** Agent's current working directory. Falls back to bootWorkingDirectory if absent. */
  cwd?: string;
}

export interface TerminalInputCommand {
  type: "terminal_input";
  terminal_id: string;
  data: string;
}

export interface TerminalResizeCommand {
  type: "terminal_resize";
  terminal_id: string;
  cols: number;
  rows: number;
}

export interface TerminalKillCommand {
  type: "terminal_kill";
  terminal_id: string;
}

export interface SearchFilesCommand {
  type: "search_files";
  /** Substring to match against file paths. Empty string returns top files by mtime. */
  query: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Maximum number of results to return. Defaults to 5. */
  max_results?: number;
  /** Working directory to scope the search to. When provided, only files
   *  within this directory (relative to the index root) are returned. */
  cwd?: string;
}

export interface ListInDirectoryCommand {
  type: "list_in_directory";
  /** Absolute path to list entries in. */
  path: string;
  /** When true, response includes non-directory entries in `files`. */
  include_files?: boolean;
  /** Max entries to return (folders + files combined). */
  limit?: number;
  /** Number of entries to skip before returning. */
  offset?: number;
}

export interface ReadFileCommand {
  type: "read_file";
  /** Absolute path to the file to read. */
  path: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface ListMemoryCommand {
  type: "list_memory";
  /** Echoed back in every response chunk for request correlation. */
  request_id: string;
  /** The agent whose memory to list. */
  agent_id: string;
}

export interface EnableMemfsCommand {
  type: "enable_memfs";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent to enable memfs for. */
  agent_id: string;
}

export type WsProtocolCommand =
  | InputCommand
  | ChangeDeviceStateCommand
  | AbortMessageCommand
  | SyncCommand
  | TerminalSpawnCommand
  | TerminalInputCommand
  | TerminalResizeCommand
  | TerminalKillCommand
  | SearchFilesCommand
  | ListInDirectoryCommand
  | ReadFileCommand
  | ListMemoryCommand
  | EnableMemfsCommand;

export type WsProtocolMessage =
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | QueueUpdateMessage
  | StreamDeltaMessage
  | SubagentStateUpdateMessage;

export type { StopReasonType };
