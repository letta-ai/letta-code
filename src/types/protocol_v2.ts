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
import type {
  DmPolicy,
  SlackChannelMode,
  SlackDefaultPermissionMode,
} from "../channels/types";
import type { CronTask } from "../cron";

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
  | "memory"
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

export interface PermissionSuggestion {
  id: string;
  text: string;
}

export interface CanUseToolControlRequestBody {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_call_id: string;
  permission_suggestions: PermissionSuggestion[];
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

export type ReflectionTriggerMode = "off" | "step-count" | "compaction-event";

export type ReflectionSettingsScope = "local_project" | "global" | "both";

export interface ReflectionSettingsSnapshot {
  agent_id: string;
  trigger: ReflectionTriggerMode;
  step_count: number;
}

export type ChannelId = "telegram" | "slack" | "discord";

export interface ChannelSummary {
  channel_id: ChannelId;
  display_name: string;
  configured: boolean;
  enabled: boolean;
  running: boolean;
  dm_policy: DmPolicy | null;
  pending_pairings_count: number;
  approved_users_count: number;
  routes_count: number;
}

export type ChannelConfigSnapshot =
  | {
      channel_id: "telegram";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_token: boolean;
    }
  | {
      channel_id: "slack";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      mode: SlackChannelMode;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_bot_token: boolean;
      has_app_token: boolean;
    }
  | {
      channel_id: "discord";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_token: boolean;
    };

export type ChannelAccountSnapshot =
  | {
      channel_id: "telegram";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_token: boolean;
      binding: {
        agent_id: string | null;
        conversation_id: string | null;
      };
      created_at: string;
      updated_at: string;
    }
  | {
      channel_id: "slack";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      mode: SlackChannelMode;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_bot_token: boolean;
      has_app_token: boolean;
      agent_id: string | null;
      default_permission_mode: SlackDefaultPermissionMode;
      created_at: string;
      updated_at: string;
    }
  | {
      channel_id: "discord";
      account_id: string;
      display_name?: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      dm_policy: DmPolicy;
      allowed_users: string[];
      has_token: boolean;
      agent_id: string | null;
      created_at: string;
      updated_at: string;
    };

export interface ChannelPendingPairing {
  account_id: string;
  code: string;
  sender_id: string;
  sender_name?: string;
  chat_id: string;
  created_at: string;
  expires_at: string;
}

export interface ChannelRouteSnapshot {
  channel_id: ChannelId;
  account_id: string;
  chat_id: string;
  chat_type?: "direct" | "channel";
  thread_id?: string | null;
  agent_id: string;
  conversation_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ChannelTargetSnapshot {
  channel_id: ChannelId;
  account_id: string;
  target_id: string;
  target_type: "channel";
  chat_id: string;
  label: string;
  discovered_at: string;
  last_seen_at: string;
  last_message_id?: string;
}

/**
 * Git repository state for the current working directory.
 * Null when the CWD is not inside a git repository.
 */
export interface GitContext {
  /** Current branch name. Null on detached HEAD or repos with no commits. */
  branch: string | null;
  /** Up to 10 local branches sorted by most-recently-committed, excluding the current branch. */
  recent_branches: string[];
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
  git_context: GitContext | null;
  letta_code_version: string | null;
  current_toolset: ToolsetName | null;
  current_toolset_preference: ToolsetPreference;
  current_loaded_tools: string[];
  current_available_skills: AvailableSkillSummary[];
  background_processes: BackgroundProcessSummary[];
  pending_control_requests: PendingControlRequest[];
  memory_directory: string | null;
  reflection_settings: ReflectionSettingsSnapshot | null;
  /** Remote slash command IDs this letta-code version can handle via `execute_command`. */
  supported_commands: string[];
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
  | "system"
  | "channel";

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
  plan_file_path: string | null;
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

export interface SlashCommandStartMessage extends UmiLifecycleMessageBase {
  message_type: "slash_command_start";
  command_id: string;
  input: string;
}

export interface SlashCommandEndMessage extends UmiLifecycleMessageBase {
  message_type: "slash_command_end";
  command_id: string;
  input: string;
  output: string;
  success: boolean;
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
  | SlashCommandStartMessage
  | SlashCommandEndMessage
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
  parent_agent_id?: string;
  parent_conversation_id?: string;
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
  selected_permission_suggestion_ids?: string[];
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
 * In v2, the WS server accepts runtime-scoped chat/device commands plus
 * device capability commands (filesystem, memory, cron, terminals).
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
  /** Echoed back in the response for request correlation. */
  request_id?: string;
}

export interface GetTreeCommand {
  type: "get_tree";
  /** Absolute path to the root of the subtree to fetch. */
  path: string;
  /** Maximum depth of the subtree to return (e.g. 3). */
  depth: number;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface ReadFileCommand {
  type: "read_file";
  /** Absolute path to the file to read. */
  path: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface WriteFileCommand {
  type: "write_file";
  /** Absolute path to the file to write. */
  path: string;
  /** The full file content to write. */
  content: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface WatchFileCommand {
  type: "watch_file";
  /** Absolute path to the file to watch for external changes. */
  path: string;
  request_id: string;
}

export interface UnwatchFileCommand {
  type: "unwatch_file";
  /** Absolute path to the file to stop watching. */
  path: string;
  request_id: string;
}

/** Bidirectional: Egwalker CRDT ops for collaborative editing. */
export interface FileOpsCommand {
  type: "file_ops";
  /** Absolute path to the file being edited. */
  path: string;
  /** Serialized causal-graph entries. */
  cg_entries: {
    agent: string;
    seq: number;
    len: number;
    parents: [string, number][];
  }[];
  /** The operations (insert / delete). */
  ops: {
    type: "ins" | "del";
    pos: number;
    content?: string;
  }[];
  /** Who generated these ops (e.g. 'window-abc', 'agent-xyz'). */
  source: string;
  /** Full document content after these ops were applied. */
  document_content?: string;
}

export interface EditFileCommand {
  type: "edit_file";
  /** Absolute path to the file to edit. */
  file_path: string;
  /** The exact text to find and replace. */
  old_string: string;
  /** The replacement text. */
  new_string: string;
  /** When true, replace all occurrences. */
  replace_all?: boolean;
  /** Expected number of replacements (validation). */
  expected_replacements?: number;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface ListMemoryCommand {
  type: "list_memory";
  /** Echoed back in every response chunk for request correlation. */
  request_id: string;
  /** The agent whose memory to list. */
  agent_id: string;
  /** When true, include parsed file references for graph edges. */
  include_references?: boolean;
}

export interface MemoryHistoryCommand {
  type: "memory_history";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory history to fetch. */
  agent_id: string;
  /** Relative path within the memory directory (e.g. "system/persona.md"). */
  file_path: string;
  /** Max commits to return (default 50). */
  limit?: number;
}

export interface MemoryFileAtRefCommand {
  type: "memory_file_at_ref";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory to read. */
  agent_id: string;
  /** Relative path within the memory directory. */
  file_path: string;
  /** Git SHA to read the file at. */
  ref: string;
}

export interface EnableMemfsCommand {
  type: "enable_memfs";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent to enable memfs for. */
  agent_id: string;
}

export interface ListModelsCommand {
  type: "list_models";
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface UpdateModelPayload {
  /** Preferred model identifier from models.json (e.g. "sonnet") */
  model_id?: string;
  /** Optional direct handle override (e.g. "anthropic/claude-sonnet-4-6") */
  model_handle?: string;
}

export interface UpdateModelCommand {
  type: "update_model";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Runtime scope — identifies which agent + conversation this targets */
  runtime: RuntimeScope;
  payload: UpdateModelPayload;
}

export interface ListModelsResponseModelEntry {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
}

export interface ListModelsResponseMessage {
  type: "list_models_response";
  request_id: string;
  success: boolean;
  entries: ListModelsResponseModelEntry[];
  /** Handles available to this user from the API. null = lookup failed; absent = old server. */
  available_handles?: string[] | null;
  /** BYOK provider name → base provider (e.g. "lc-anthropic" → "anthropic") */
  byok_provider_aliases?: Record<string, string>;
  error?: string;
}

export interface UpdateModelResponseMessage {
  type: "update_model_response";
  request_id: string;
  success: boolean;
  runtime?: RuntimeScope;
  applied_to?: "agent" | "conversation";
  model_id?: string;
  model_handle?: string;
  model_settings?: Record<string, unknown> | null;
  error?: string;
}

export interface CronListCommand {
  type: "cron_list";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Optional agent filter. */
  agent_id?: string;
  /** Optional conversation filter. */
  conversation_id?: string;
}

export interface CronAddCommand {
  type: "cron_add";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  /** Optional ISO timestamp for one-shot tasks. */
  scheduled_for?: string | null;
}

export interface CronGetCommand {
  type: "cron_get";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronDeleteCommand {
  type: "cron_delete";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronDeleteAllCommand {
  type: "cron_delete_all";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
}

export interface SkillEnableCommand {
  type: "skill_enable";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Absolute path to the skill directory on the local machine. */
  skill_path: string;
}

export interface SkillDisableCommand {
  type: "skill_disable";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Skill name (symlink name in ~/.letta/skills/). */
  name: string;
}

export interface CreateAgentCommand {
  type: "create_agent";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Built-in personality preset to create. */
  personality: "memo" | "linus" | "kawaii";
  /** Model identifier (e.g. "sonnet", "gpt-4o"). Uses default if omitted. */
  model?: string;
  /** Whether to pin the agent globally after creation. Defaults to true. */
  pin_global?: boolean;
}

export interface GetReflectionSettingsCommand {
  type: "get_reflection_settings";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  runtime: RuntimeScope;
}

export interface SetReflectionSettingsCommand {
  type: "set_reflection_settings";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  runtime: RuntimeScope;
  settings: {
    trigger: ReflectionTriggerMode;
    step_count: number;
  };
  scope?: ReflectionSettingsScope;
}

export interface ChannelsListCommand {
  type: "channels_list";
  request_id: string;
}

export interface ChannelAccountsListCommand {
  type: "channel_accounts_list";
  request_id: string;
  channel_id: ChannelId;
}

export type ChannelAccountCreatePayload =
  | {
      account_id?: string;
      display_name?: string;
      enabled?: boolean;
      token?: string;
      dm_policy?: DmPolicy;
      allowed_users?: string[];
    }
  | {
      account_id?: string;
      display_name?: string;
      enabled?: boolean;
      bot_token?: string;
      app_token?: string;
      mode?: SlackChannelMode;
      agent_id?: string | null;
      default_permission_mode?: SlackDefaultPermissionMode;
      dm_policy?: DmPolicy;
      allowed_users?: string[];
    };

export interface ChannelAccountCreateCommand {
  type: "channel_account_create";
  request_id: string;
  channel_id: ChannelId;
  account: ChannelAccountCreatePayload;
}

export interface ChannelAccountUpdateCommand {
  type: "channel_account_update";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
  patch:
    | {
        display_name?: string;
        enabled?: boolean;
        token?: string;
        dm_policy?: DmPolicy;
        allowed_users?: string[];
      }
    | {
        display_name?: string;
        enabled?: boolean;
        bot_token?: string;
        app_token?: string;
        mode?: SlackChannelMode;
        agent_id?: string | null;
        default_permission_mode?: SlackDefaultPermissionMode;
        dm_policy?: DmPolicy;
        allowed_users?: string[];
      };
}

export interface ChannelAccountBindCommand {
  type: "channel_account_bind";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
  runtime: RuntimeScope;
}

export interface ChannelAccountUnbindCommand {
  type: "channel_account_unbind";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
}

export interface ChannelAccountDeleteCommand {
  type: "channel_account_delete";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
}

export interface ChannelAccountStartCommand {
  type: "channel_account_start";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
}

export interface ChannelAccountStopCommand {
  type: "channel_account_stop";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
}

export interface ChannelGetConfigCommand {
  type: "channel_get_config";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelSetConfigCommand {
  type: "channel_set_config";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
  config:
    | {
        token?: string;
        dm_policy?: DmPolicy;
        allowed_users?: string[];
      }
    | {
        bot_token?: string;
        app_token?: string;
        mode?: SlackChannelMode;
        dm_policy?: DmPolicy;
        allowed_users?: string[];
      };
}

export interface ChannelStartCommand {
  type: "channel_start";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelStopCommand {
  type: "channel_stop";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelPairingsListCommand {
  type: "channel_pairings_list";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelPairingBindCommand {
  type: "channel_pairing_bind";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
  runtime: RuntimeScope;
  code: string;
}

export interface ChannelRoutesListCommand {
  type: "channel_routes_list";
  request_id: string;
  channel_id?: ChannelId;
  account_id?: string;
  agent_id?: string;
  conversation_id?: string;
}

export interface ChannelTargetsListCommand {
  type: "channel_targets_list";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelTargetBindCommand {
  type: "channel_target_bind";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
  runtime: RuntimeScope;
  target_id: string;
}

export interface ChannelRouteRemoveCommand {
  type: "channel_route_remove";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
  chat_id: string;
}

export interface ChannelRouteUpdateCommand {
  type: "channel_route_update";
  request_id: string;
  channel_id: ChannelId;
  account_id?: string;
  chat_id: string;
  runtime: RuntimeScope;
}

export interface CronListResponseMessage {
  type: "cron_list_response";
  request_id: string;
  tasks: CronTask[];
  success: boolean;
  error?: string;
}

export interface CronAddResponseMessage {
  type: "cron_add_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
  warning?: string;
  error?: string;
}

export interface CronGetResponseMessage {
  type: "cron_get_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task: CronTask | null;
  error?: string;
}

export interface CronDeleteResponseMessage {
  type: "cron_delete_response";
  request_id: string;
  success: boolean;
  found: boolean;
  error?: string;
}

export interface CronDeleteAllResponseMessage {
  type: "cron_delete_all_response";
  request_id: string;
  success: boolean;
  agent_id: string;
  deleted: number;
  error?: string;
}

export interface CronsUpdatedMessage {
  type: "crons_updated";
  timestamp: number;
  agent_id?: string;
  conversation_id?: string | null;
}

export interface CreateAgentResponseMessage {
  type: "create_agent_response";
  request_id: string;
  success: boolean;
  agent_id?: string;
  name?: string;
  model?: string;
  error?: string;
}

export interface GetReflectionSettingsResponseMessage {
  type: "get_reflection_settings_response";
  request_id: string;
  success: boolean;
  reflection_settings: ReflectionSettingsSnapshot | null;
  error?: string;
}

export interface SetReflectionSettingsResponseMessage {
  type: "set_reflection_settings_response";
  request_id: string;
  success: boolean;
  reflection_settings: ReflectionSettingsSnapshot | null;
  scope: ReflectionSettingsScope;
  error?: string;
}

export interface ChannelsListResponseMessage {
  type: "channels_list_response";
  request_id: string;
  success: boolean;
  channels: ChannelSummary[];
  error?: string;
}

export interface ChannelAccountsListResponseMessage {
  type: "channel_accounts_list_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  accounts: ChannelAccountSnapshot[];
  error?: string;
}

export interface ChannelAccountCreateResponseMessage {
  type: "channel_account_create_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelAccountUpdateResponseMessage {
  type: "channel_account_update_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelAccountBindResponseMessage {
  type: "channel_account_bind_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelAccountUnbindResponseMessage {
  type: "channel_account_unbind_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelAccountDeleteResponseMessage {
  type: "channel_account_delete_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account_id: string;
  deleted: boolean;
  error?: string;
}

export interface ChannelAccountStartResponseMessage {
  type: "channel_account_start_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelAccountStopResponseMessage {
  type: "channel_account_stop_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  account: ChannelAccountSnapshot | null;
  error?: string;
}

export interface ChannelGetConfigResponseMessage {
  type: "channel_get_config_response";
  request_id: string;
  success: boolean;
  config: ChannelConfigSnapshot | null;
  error?: string;
}

export interface ChannelSetConfigResponseMessage {
  type: "channel_set_config_response";
  request_id: string;
  success: boolean;
  config: ChannelConfigSnapshot | null;
  error?: string;
}

export interface ChannelStartResponseMessage {
  type: "channel_start_response";
  request_id: string;
  success: boolean;
  channel: ChannelSummary | null;
  error?: string;
}

export interface ChannelStopResponseMessage {
  type: "channel_stop_response";
  request_id: string;
  success: boolean;
  channel: ChannelSummary | null;
  error?: string;
}

export interface ChannelPairingsListResponseMessage {
  type: "channel_pairings_list_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  pending: ChannelPendingPairing[];
  error?: string;
}

export interface ChannelPairingBindResponseMessage {
  type: "channel_pairing_bind_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  chat_id?: string;
  route?: ChannelRouteSnapshot | null;
  error?: string;
}

export interface ChannelRoutesListResponseMessage {
  type: "channel_routes_list_response";
  request_id: string;
  success: boolean;
  channel_id?: ChannelId;
  routes: ChannelRouteSnapshot[];
  error?: string;
}

export interface ChannelRouteRemoveResponseMessage {
  type: "channel_route_remove_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  chat_id: string;
  found: boolean;
  error?: string;
}

export interface ChannelRouteUpdateResponseMessage {
  type: "channel_route_update_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  chat_id: string;
  route?: ChannelRouteSnapshot | null;
  error?: string;
}

export interface ChannelTargetsListResponseMessage {
  type: "channel_targets_list_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  targets: ChannelTargetSnapshot[];
  error?: string;
}

export interface ChannelTargetBindResponseMessage {
  type: "channel_target_bind_response";
  request_id: string;
  success: boolean;
  channel_id: ChannelId;
  target_id: string;
  chat_id?: string;
  route?: ChannelRouteSnapshot | null;
  error?: string;
}

export interface ChannelsUpdatedMessage {
  type: "channels_updated";
  timestamp: number;
  channel_id?: ChannelId;
}

export interface ChannelAccountsUpdatedMessage {
  type: "channel_accounts_updated";
  timestamp: number;
  channel_id: ChannelId;
  account_id?: string;
}

export interface ChannelPairingsUpdatedMessage {
  type: "channel_pairings_updated";
  timestamp: number;
  channel_id: ChannelId;
}

export interface ChannelRoutesUpdatedMessage {
  type: "channel_routes_updated";
  timestamp: number;
  channel_id: ChannelId;
  agent_id?: string;
  conversation_id?: string | null;
}

export interface ChannelTargetsUpdatedMessage {
  type: "channel_targets_updated";
  timestamp: number;
  channel_id: ChannelId;
}

/**
 * Generic slash-command dispatch from the web app.
 * The device handles the `command_id` and emits `command_start` /
 * `command_end` stream deltas with the result.
 */
export interface ExecuteCommandCommand {
  type: "execute_command";
  /** Which slash command to run (e.g., "clear") */
  command_id: string;
  /** Correlation id (echoed in the response stream deltas) */
  request_id: string;
  /** Runtime scope — identifies which agent + conversation this targets */
  runtime: RuntimeScope;
  /** Optional command arguments (everything after the command name). */
  args?: string;
}

// ─────────────────────────────────────────────────
//  Git branch commands
// ─────────────────────────────────────────────────

export interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

export interface SearchBranchesCommand {
  type: "search_branches";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Substring filter for branch names. Empty string returns all branches. */
  query: string;
  /** Maximum number of results to return. Defaults to 20. */
  max_results?: number;
  /** Working directory to run git in. Falls back to conversation cwd. */
  cwd?: string;
}

export interface SearchBranchesResponse {
  type: "search_branches_response";
  request_id: string;
  branches: GitBranchInfo[];
  success: boolean;
  error?: string;
}

export interface CheckoutBranchCommand {
  type: "checkout_branch";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Branch name to checkout. */
  branch: string;
  /** Create a new branch if it doesn't exist. */
  create?: boolean;
  /** Working directory to run git in. Falls back to conversation cwd. */
  cwd?: string;
}

export interface CheckoutBranchResponse {
  type: "checkout_branch_response";
  request_id: string;
  /** The branch now checked out. */
  branch: string;
  success: boolean;
  error?: string;
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
  | GetTreeCommand
  | ReadFileCommand
  | WriteFileCommand
  | WatchFileCommand
  | UnwatchFileCommand
  | EditFileCommand
  | FileOpsCommand
  | ListMemoryCommand
  | MemoryHistoryCommand
  | MemoryFileAtRefCommand
  | EnableMemfsCommand
  | ListModelsCommand
  | UpdateModelCommand
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronDeleteCommand
  | CronDeleteAllCommand
  | SkillEnableCommand
  | SkillDisableCommand
  | CreateAgentCommand
  | GetReflectionSettingsCommand
  | SetReflectionSettingsCommand
  | ChannelsListCommand
  | ChannelAccountsListCommand
  | ChannelAccountCreateCommand
  | ChannelAccountUpdateCommand
  | ChannelAccountBindCommand
  | ChannelAccountUnbindCommand
  | ChannelAccountDeleteCommand
  | ChannelAccountStartCommand
  | ChannelAccountStopCommand
  | ChannelGetConfigCommand
  | ChannelSetConfigCommand
  | ChannelStartCommand
  | ChannelStopCommand
  | ChannelPairingsListCommand
  | ChannelPairingBindCommand
  | ChannelRoutesListCommand
  | ChannelTargetsListCommand
  | ChannelTargetBindCommand
  | ChannelRouteRemoveCommand
  | ChannelRouteUpdateCommand
  | ExecuteCommandCommand
  | SearchBranchesCommand
  | CheckoutBranchCommand;

export type WsProtocolMessage =
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | QueueUpdateMessage
  | StreamDeltaMessage
  | SubagentStateUpdateMessage
  | ListModelsResponseMessage
  | UpdateModelResponseMessage
  | ChannelsListResponseMessage
  | ChannelAccountsListResponseMessage
  | ChannelAccountCreateResponseMessage
  | ChannelAccountUpdateResponseMessage
  | ChannelAccountBindResponseMessage
  | ChannelAccountUnbindResponseMessage
  | ChannelAccountDeleteResponseMessage
  | ChannelAccountStartResponseMessage
  | ChannelAccountStopResponseMessage
  | ChannelGetConfigResponseMessage
  | ChannelSetConfigResponseMessage
  | ChannelStartResponseMessage
  | ChannelStopResponseMessage
  | ChannelPairingsListResponseMessage
  | ChannelPairingBindResponseMessage
  | ChannelRoutesListResponseMessage
  | ChannelTargetsListResponseMessage
  | ChannelTargetBindResponseMessage
  | ChannelRouteRemoveResponseMessage
  | ChannelRouteUpdateResponseMessage
  | ChannelsUpdatedMessage
  | ChannelAccountsUpdatedMessage
  | ChannelPairingsUpdatedMessage
  | ChannelRoutesUpdatedMessage
  | ChannelTargetsUpdatedMessage;

export type { StopReasonType };
