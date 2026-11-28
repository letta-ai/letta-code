import type {
  AgentCreateParams,
  AgentListParams,
  AgentState,
  AgentUpdateParams,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type {
  Message as LettaMessage,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import type {
  Conversation,
  ConversationCreateParams,
  ConversationListParams,
  ConversationRecompileParams,
  ConversationUpdateParams,
} from "@letta-ai/letta-client/resources/conversations/conversations";
import type {
  CompactionResponse,
  MessageCompactParams,
  MessageListParams,
} from "@letta-ai/letta-client/resources/conversations/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { ExperimentId } from "@/experiments/types";
import type { ConnectProviderOAuthConfig } from "@/types/provider-oauth-config";
import type { TurnFinishedAckCommand } from "@/types/turn-finished-protocol";
import type {
  AppServerInfoCommand,
  AppServerInfoResponseMessage,
} from "./app-server-info";
import type {
  ApprovalClassificationEndMessage,
  UmiLifecycleMessageBase,
} from "./approval-classification-protocol";
import type { DeviceBackgroundProcessStatus } from "./background-process-protocol";
import type {
  ChatGPTRateLimitResetCreditConsumeCommand,
  ChatGPTRateLimitResetCreditConsumeResponseMessage,
  ChatGPTRateLimitResetCreditsListCommand,
  ChatGPTRateLimitResetCreditsListResponseMessage,
  ChatGPTUsageReadCommand,
  ChatGPTUsageReadResponseMessage,
} from "./chatgpt-usage-protocol";
import type { ConversationForkBody } from "./conversation-fork-protocol";
import type * as CwdProtocol from "./cwd-protocol";
import type {
  ExternalToolCallMessage,
  ExternalToolCallResponseCommand,
  RuntimeExternalToolsUpdateCommand,
  RuntimeExternalToolsUpdateResponseMessage,
} from "./external-tool-protocol";
import type {
  WriteFileCommand,
  WriteFileResponseMessage,
} from "./file-write-protocol";
import type { InputCommand } from "./input-command";
import type {
  LoopErrorMessage,
  LoopState,
  RetryMessage,
  StatusMessage,
} from "./loop-status-protocol";
import type {
  AgentRuntimeScope,
  ConversationRuntimeScope,
} from "./runtime-scope";
import type {
  DevicePermissionMode,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
} from "./runtime-start-protocol";
import type {
  CronProtocolCommand,
  CronProtocolResponseMessage,
} from "./schedule-protocol";
import type * as SubagentProtocol from "./subagent-protocol";
import type * as TaskControlProtocol from "./task-control-protocol";

export type * from "./subagent-protocol";

import type * as TeleportProtocol from "./teleport-protocol";
import type {
  ToolsetName,
  ToolsetOption,
  ToolsetPreference,
} from "./toolset-protocol";

export type * from "./approval-classification-protocol";
export type * from "./background-process-protocol";
export type * from "./chatgpt-usage-protocol";
export type * from "./cwd-protocol";
export type * from "./external-tool-protocol";
export type * from "./file-write-protocol";
export type * from "./loop-status-protocol";
export type * from "./runtime-scope";
export type * from "./runtime-start-protocol";
export type * from "./schedule-protocol";
export type * from "./task-control-protocol";
export type * from "./teleport-protocol";
export type * from "./toolset-protocol";

export type DmPolicy = "pairing" | "allowlist" | "open";
export type { ExperimentId } from "@/experiments/types";
export type ExperimentSource = "override" | "env" | "default";

export interface ExperimentSnapshot {
  id: ExperimentId;
  label: string;
  description: string;
  envVar?: string;
  enabled: boolean;
  source: ExperimentSource;
  override: boolean | null;
}

export interface RuntimeEnvelope {
  runtime: ConversationRuntimeScope;
  event_seq: number;
  emitted_at: string;
  idempotency_key: string;
}

export interface AvailableSkillSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  source: "bundled" | "global" | "agent" | "project";
}

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
export type ReflectionMergeMode = "auto" | "explicit";
export type ReflectionSettingsScope = "local_project" | "global" | "both";
export interface ReflectionSettingsSnapshot {
  agent_id: string;
  trigger: ReflectionTriggerMode;
  step_count: number;
  merge: ReflectionMergeMode;
  merge_instructions: string;
}
export type ChannelId = string;

export type ChannelPluginConfig = Record<string, unknown>;

export interface ChannelConfigFieldBase {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  restartRequired?: boolean;
  scope?: "app" | "account";
}

export interface ChannelConfigTextField extends ChannelConfigFieldBase {
  type: "text";
  default?: string;
  placeholder?: string;
}

export interface ChannelConfigSecretField extends ChannelConfigFieldBase {
  type: "secret";
  placeholder?: string;
}

export interface ChannelConfigSelectOption {
  value: string;
  label: string;
}

export interface ChannelConfigSelectField extends ChannelConfigFieldBase {
  type: "select";
  options: ChannelConfigSelectOption[];
  default?: string;
}

export interface ChannelConfigBooleanField extends ChannelConfigFieldBase {
  type: "boolean";
  default?: boolean;
}

export interface ChannelConfigNumberField extends ChannelConfigFieldBase {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
}

export interface ChannelConfigStringArrayField extends ChannelConfigFieldBase {
  type: "string-array";
  default?: string[];
  placeholder?: string;
}

export interface ChannelConfigKeyValueMapField extends ChannelConfigFieldBase {
  type: "key-value-map";
  valueType: "string" | "number";
  default?: Record<string, string | number>;
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export type ChannelConfigField =
  | ChannelConfigTextField
  | ChannelConfigSecretField
  | ChannelConfigSelectField
  | ChannelConfigBooleanField
  | ChannelConfigNumberField
  | ChannelConfigStringArrayField
  | ChannelConfigKeyValueMapField;

export interface ChannelConfigSchema {
  version: 1;
  fields: ChannelConfigField[];
}

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
  config_schema: ChannelConfigSchema | null;
}

export interface ChannelConfigSnapshot {
  channel_id: ChannelId;
  account_id: string;
  display_name?: string;
  enabled: boolean;
  dm_policy: DmPolicy;
  allowed_users: string[];
  config: ChannelPluginConfig;
}

export interface ChannelAccountSnapshot {
  channel_id: ChannelId;
  account_id: string;
  display_name?: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  dm_policy: DmPolicy;
  allowed_users: string[];
  config: ChannelPluginConfig;
  created_at: string;
  updated_at: string;
}

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
  outbound_enabled?: boolean;
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

export interface GitContext {
  branch: string | null;
  recent_branches: string[];
}

export interface DeviceStatus extends DeviceBackgroundProcessStatus {
  current_connection_id: string | null;
  connection_name: string | null;
  is_online: boolean;
  is_processing: boolean;
  current_permission_mode: DevicePermissionMode;
  current_working_directory: string | null;
  cwd_revision?: number;
  git_context: GitContext | null;
  letta_code_version: string | null;
  current_toolset: ToolsetName | null;
  current_toolset_preference: ToolsetPreference;
  available_toolsets: ToolsetOption[];
  current_loaded_tools: string[];
  current_available_skills: AvailableSkillSummary[];
  pending_control_requests: PendingControlRequest[];
  experiments: ExperimentSnapshot[];
  memory_directory: string | null;
  cwd_map?: Record<string, string>;
  boot_working_directory?: string | null;
  should_doctor?: boolean;
  reflection_settings: ReflectionSettingsSnapshot | null;
  supported_commands: string[];
  mod_commands?: ModCommandInfo[];
}

export interface ModCommandInfo {
  id: string;
  description: string;
  args?: string;
}

export type QueueMessageKind =
  | "message"
  | "task_notification"
  | "cron_prompt"
  | "mod_continue";

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
  paused?: boolean;
}

export interface DeviceStatusUpdateMessage extends RuntimeEnvelope {
  type: "update_device_status";
  device_status: DeviceStatus;
}

export interface LoopStatusUpdateMessage extends RuntimeEnvelope {
  type: "update_loop_status";
  loop_status: LoopState;
}

export interface QueueUpdateMessage extends RuntimeEnvelope {
  type: "update_queue";
  queue: QueueMessage[];
  removed?: import("./queue-update-protocol").QueueRemovalTransition[];
}

export type MessageDelta = { type: "message" } & LettaStreamingResponse;

export interface ClientToolStartMessage extends UmiLifecycleMessageBase {
  message_type: "client_tool_start";
  tool_call_id: string;
  tool_name?: string;
  tool_args?: string;
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

export type StreamDelta =
  | MessageDelta
  | ApprovalClassificationEndMessage
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

export interface TurnFinishedMessage extends RuntimeEnvelope {
  type: "turn_finished";
  turn_id: string;
  stop_reason: StopReasonType;
  terminal_consumer_ids?: string[];
  run_id?: string;
  error?: string;
  usage?: LettaStreamingResponse.LettaUsageStatistics;
}

export interface SubagentSnapshotToolCall {
  id: string;
  name: string;
  args: string;
}

export interface SubagentSnapshot extends SubagentProtocol.SubagentEvents {
  subagent_id: string;
  subagent_type: string;
  description: string;
  prompt?: string;
  status: "pending" | "running" | "completed" | "error";
  agent_url: string | null;
  agent_id?: string | null;
  conversation_id?: string | null;
  super_run_id?: string;
  model?: string;
  is_background?: boolean;
  claims_parent_runtime?: boolean;
  silent?: boolean;
  tool_call_id?: string;
  parent_agent_id?: string;
  parent_conversation_id?: string;
  start_time: number;
  tool_calls: SubagentSnapshotToolCall[];
  progress_texts?: { id: string; at: string; text: string }[];
  total_tokens: number;
  duration_ms: number;
  error?: string;
  result?: string;
}

export interface SubagentStateUpdateMessage extends RuntimeEnvelope {
  type: "update_subagent_state";
  subagents: SubagentSnapshot[];
}

export type { ClientPreferences } from "./client-preferences";
export type {
  ApprovalResponseAllowDecision,
  ApprovalResponseBody,
  ApprovalResponseDecision,
  ApprovalResponseDenyDecision,
  InputApprovalResponsePayload,
  InputCommand,
  InputPayload,
} from "./input-command";
export type {
  ClientToolsetConfig,
  InputCreateMessagePayload,
} from "./input-create-message";
export interface InputAcceptedResponseMessage {
  type: "input_accepted";
  request_id: string;
  runtime: ConversationRuntimeScope;
  accepted: boolean;
  disposition?: "started" | "queued";
  duplicate_owner_live?: boolean;
  error?: string;
}

export interface ChangeDeviceStatePayload {
  mode?: DevicePermissionMode;
  cwd?: string;
  agent_id?: string | null;
  conversation_id?: string | null;
}

export interface ChangeDeviceStateCommand {
  type: "change_device_state";
  runtime: ConversationRuntimeScope;
  payload: ChangeDeviceStatePayload;
}

export interface AbortMessageCommand {
  type: "abort_message";
  runtime: ConversationRuntimeScope;
  request_id?: string;
  run_id?: string | null;
}

export interface SyncCommand {
  type: "sync";
  runtime: ConversationRuntimeScope;
  request_id?: string;
  recover_approvals?: boolean;
  resume_interrupted_turn?: boolean;
  force_device_status?: boolean;
}

export interface TerminalSpawnCommand {
  type: "terminal_spawn";
  terminal_id: string;
  cols: number;
  rows: number;
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

export interface TerminalOutputMessage {
  type: "terminal_output";
  terminal_id: string;
  data: string;
}

export interface TerminalSpawnedMessage {
  type: "terminal_spawned";
  terminal_id: string;
  pid: number;
}

export interface TerminalExitedMessage {
  type: "terminal_exited";
  terminal_id: string;
  exitCode: number;
  error?: string;
}

export interface AbortMessageResponseMessage {
  type: "abort_message_response";
  request_id: string;
  runtime: ConversationRuntimeScope;
  aborted: boolean;
  success: boolean;
  error?: string;
}

export interface SyncResponseMessage {
  type: "sync_response";
  request_id: string;
  runtime: ConversationRuntimeScope;
  success: boolean;
  error?: string;
}

export interface SearchFilesCommand {
  type: "search_files";
  query: string;
  request_id: string;
  max_results?: number;
  cwd?: string;
}

export interface GrepInFilesCommand {
  type: "grep_in_files";
  request_id: string;
  query: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  glob?: string;
  cwd?: string;
  max_results?: number;
  context_lines?: number;
}

export interface GrepInFilesMatch {
  path: string;
  line: number;
  column: number;
  column_end: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface SearchFilesEntry {
  path: string;
  type: "file";
}

export interface SearchFilesResponseMessage {
  type: "search_files_response";
  request_id: string;
  files: SearchFilesEntry[];
  success: boolean;
  error?: string;
}

export interface GrepInFilesResponseMessage {
  type: "grep_in_files_response";
  request_id: string;
  success: boolean;
  matches: GrepInFilesMatch[];
  total_matches: number;
  total_files: number;
  truncated: boolean;
  error?: string;
}

export interface ListInDirectoryCommand {
  type: "list_in_directory";
  path: string;
  include_files?: boolean;
  limit?: number;
  offset?: number;
  request_id?: string;
}

export interface ListInDirectoryResponseMessage {
  type: "list_in_directory_response";
  path: string;
  folders: string[];
  files?: string[];
  hasMore: boolean;
  total?: number;
  success: boolean;
  error?: string;
  request_id?: string;
}

export interface GetTreeCommand {
  type: "get_tree";
  path: string;
  depth: number;
  request_id: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
}

export interface GetTreeResponseMessage {
  type: "get_tree_response";
  path: string;
  request_id: string;
  entries: TreeEntry[];
  has_more_depth: boolean;
  success: boolean;
  error?: string;
}

export interface ReadFileCommand {
  type: "read_file";
  path: string;
  request_id: string;
  encoding?: "utf8" | "base64";
}

export interface ReadFileResponseMessage {
  type: "read_file_response";
  request_id: string;
  path: string;
  content: string | null;
  encoding?: "utf8" | "base64";
  success: boolean;
  error?: string;
}

export interface WatchFileCommand {
  type: "watch_file";
  path: string;
  request_id: string;
}

export interface UnwatchFileCommand {
  type: "unwatch_file";
  path: string;
  request_id: string;
}

export interface FileOpsCommand {
  type: "file_ops";
  path: string;
  cg_entries: {
    agent: string;
    seq: number;
    len: number;
    parents: [string, number][];
  }[];
  ops: {
    type: "ins" | "del";
    pos: number;
    content?: string;
  }[];
  source: string;
  document_content?: string;
}

export interface EditFileCommand {
  type: "edit_file";
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
  expected_replacements?: number;
  request_id: string;
}

export interface EditFileResponseMessage {
  type: "edit_file_response";
  request_id: string;
  file_path: string;
  message: string | null;
  replacements: number;
  start_line?: number;
  success: boolean;
  error?: string;
}

export interface FileChangedMessage {
  type: "file_changed";
  path: string;
  lastModified: number;
}

export interface ListMemoryCommand {
  type: "list_memory";
  request_id: string;
  agent_id: string;
  include_references?: boolean;
}

export interface MemoryHistoryCommand {
  type: "memory_history";
  request_id: string;
  agent_id: string;
  file_path?: string;
  limit?: number;
}

export interface MemoryFileAtRefCommand {
  type: "memory_file_at_ref";
  request_id: string;
  agent_id: string;
  file_path: string;
  ref: string;
}

export interface ReadMemoryFileCommand {
  type: "read_memory_file";
  request_id: string;
  agent_id: string;
  path: string;
  encoding?: "utf8" | "base64";
}

export interface WriteMemoryFileCommand {
  type: "write_memory_file";
  request_id: string;
  agent_id: string;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  commit_message?: string;
}

export interface DeleteMemoryFileCommand {
  type: "delete_memory_file";
  request_id: string;
  agent_id: string;
  path: string;
  commit_message?: string;
}

export interface MemoryCommitDiffCommand {
  type: "memory_commit_diff";
  request_id: string;
  agent_id: string;
  sha: string;
}

export interface EnableMemfsCommand {
  type: "enable_memfs";
  request_id: string;
  agent_id: string;
}

export interface MemoryFileEntry {
  relative_path: string;
  is_system: boolean;
  description: string | null;
  content: string;
  size: number;
  references?: string[];
  kind?: "markdown" | "image";
  mime_type?: string | null;
}

export interface ListMemoryResponseMessage {
  type: "list_memory_response";
  request_id: string;
  entries: MemoryFileEntry[];
  done: boolean;
  total: number;
  success: boolean;
  error?: string;
  memfs_enabled?: boolean;
  memfs_initialized?: boolean;
}

export interface MemoryHistoryCommitEntry {
  sha: string;
  message: string;
  timestamp: string;
  author_name: string | null;
}

export interface MemoryHistoryResponseMessage {
  type: "memory_history_response";
  request_id: string;
  file_path: string;
  commits: MemoryHistoryCommitEntry[];
  success: boolean;
  error?: string;
}

export interface MemoryFileAtRefResponseMessage {
  type: "memory_file_at_ref_response";
  request_id: string;
  file_path: string;
  ref: string;
  content: string | null;
  success: boolean;
  error?: string;
}

export interface ReadMemoryFileResponseMessage {
  type: "read_memory_file_response";
  request_id: string;
  agent_id: string;
  path: string;
  content: string | null;
  encoding: "utf8" | "base64";
  success: boolean;
  error?: string;
}

export interface WriteMemoryFileResponseMessage {
  type: "write_memory_file_response";
  request_id: string;
  agent_id: string;
  path: string;
  success: boolean;
  committed?: boolean;
  commit_sha?: string;
  error?: string;
}

export interface DeleteMemoryFileResponseMessage {
  type: "delete_memory_file_response";
  request_id: string;
  agent_id: string;
  path: string;
  success: boolean;
  committed?: boolean;
  commit_sha?: string;
  error?: string;
}

export interface MemoryCommitDiffResponseMessage {
  type: "memory_commit_diff_response";
  request_id: string;
  sha: string;
  diff: string | null;
  success: boolean;
  error?: string;
}

export interface EnableMemfsResponseMessage {
  type: "enable_memfs_response";
  request_id: string;
  success: boolean;
  memory_directory?: string;
  error?: string;
}

export interface MemoryUpdatedMessage {
  type: "memory_updated";
  affected_paths: string[];
  timestamp: number;
}

export interface ListModelsCommand {
  type: "list_models";
  request_id: string;
  force?: boolean;
}

export type ConnectProviderStorageTarget = "local";

export interface ListConnectProvidersCommand {
  type: "list_connect_providers";
  request_id: string;
  target: ConnectProviderStorageTarget;
}

export interface ConnectProviderCommand {
  type: "connect_provider";
  request_id: string;
  target: ConnectProviderStorageTarget;
  provider_id: string;
  auth_method_id?: string;
  fields: Record<string, string>;
  provider_name?: string;
  oauth_config?: ConnectProviderOAuthConfig;
}

export interface DisconnectProviderCommand {
  type: "disconnect_provider";
  request_id: string;
  target: ConnectProviderStorageTarget;
  provider_id: string;
  provider_name?: string;
}

export interface ConnectProviderField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  required?: boolean;
}

export interface ConnectProviderAuthMethod {
  id: string;
  label: string;
  description: string;
  fields: ConnectProviderField[];
}

export interface ConnectProviderConnectionState {
  is_connected: boolean;
  id?: string;
  provider_name?: string;
  provider_type?: string;
  auth_type?: "api" | "oauth";
  base_url?: string;
  timeout?: number | false;
  region?: string;
}

export interface ConnectProviderEntry {
  id: string;
  display_name: string;
  description: string;
  provider_type: string;
  provider_name: string;
  provider_names: string[];
  is_oauth?: boolean;
  oauth_provider_id?: string;
  requires_api_key: boolean;
  fields?: ConnectProviderField[];
  auth_methods?: ConnectProviderAuthMethod[];
  connected: ConnectProviderConnectionState;
  connected_providers: ConnectProviderConnectionState[];
}

export interface ListConnectProvidersResponseMessage {
  type: "list_connect_providers_response";
  request_id: string;
  success: boolean;
  target: ConnectProviderStorageTarget;
  providers: ConnectProviderEntry[];
  error?: string;
}

export interface ConnectProviderResponseMessage {
  type: "connect_provider_response";
  request_id: string;
  success: boolean;
  target: ConnectProviderStorageTarget;
  providers: ConnectProviderEntry[];
  models_may_have_changed: boolean;
  error?: string;
}

export interface DisconnectProviderResponseMessage {
  type: "disconnect_provider_response";
  request_id: string;
  success: boolean;
  target: ConnectProviderStorageTarget;
  providers: ConnectProviderEntry[];
  models_may_have_changed: boolean;
  error?: string;
}

export interface UpdateModelPayload {
  model_id?: string;
  model_handle?: string;
  reasoning_effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | null;
}

export interface UpdateModelCommand {
  type: "update_model";
  request_id: string;
  runtime: ConversationRuntimeScope;
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
  supportsStructuredOutputs?: boolean;
  updateArgs?: Record<string, unknown>;
}
export interface ListModelsResponseMessage {
  type: "list_models_response";
  request_id: string;
  success: boolean;
  entries: ListModelsResponseModelEntry[];
  available_handles?: string[] | null;
  byok_provider_aliases?: Record<string, string>;
  error?: string;
}

export interface UpdateModelResponseMessage {
  type: "update_model_response";
  request_id: string;
  success: boolean;
  runtime?: ConversationRuntimeScope;
  applied_to?: "agent" | "conversation";
  model_id?: string;
  model_handle?: string;
  model_settings?: Record<string, unknown> | null;
  error?: string;
}

export interface UpdateToolsetCommand {
  type: "update_toolset";
  request_id: string;
  runtime: ConversationRuntimeScope;
  toolset_preference: ToolsetPreference;
}

export interface UpdateToolsetResponseMessage {
  type: "update_toolset_response";
  request_id: string;
  success: boolean;
  runtime?: ConversationRuntimeScope;
  current_toolset?: ToolsetName;
  current_toolset_preference?: ToolsetPreference;
  error?: string;
}

export interface SkillEnableCommand {
  type: "skill_enable";
  request_id: string;
  skill_path: string;
}

export interface SkillEnableResponseMessage {
  type: "skill_enable_response";
  request_id: string;
  success: boolean;
  skill_name?: string;
  error?: string;
}

export interface SkillDisableCommand {
  type: "skill_disable";
  request_id: string;
  name: string;
}

export interface SkillDisableResponseMessage {
  type: "skill_disable_response";
  request_id: string;
  success: boolean;
  skill_name?: string;
  error?: string;
}

export interface SkillsUpdatedMessage {
  type: "skills_updated";
  timestamp: number;
}

export interface CreateAgentCommand {
  type: "create_agent";
  request_id: string;
  personality: "memo" | "tutorial" | "blank" | "linus" | "kawaii";
  model?: string;
  tags?: string[];
  pin_global?: boolean;
}
export interface AgentListCommand {
  type: "agent_list";
  request_id: string;
  query?: AgentListParams;
}

export interface AgentRetrieveCommand {
  type: "agent_retrieve";
  request_id: string;
  agent_id: string;
}

export interface AgentCreateCommand {
  type: "agent_create";
  request_id: string;
  body: AgentCreateParams;
}

export interface AgentUpdateCommand {
  type: "agent_update";
  request_id: string;
  agent_id: string;
  body: AgentUpdateParams;
}

export interface AgentDeleteCommand {
  type: "agent_delete";
  request_id: string;
  agent_id: string;
}

export interface ConversationListCommand {
  type: "conversation_list";
  request_id: string;
  query?: ConversationListParams;
}

export interface ConversationRetrieveCommand {
  type: "conversation_retrieve";
  request_id: string;
  conversation_id: string;
}

export interface ConversationCreateCommand {
  type: "conversation_create";
  request_id: string;
  body: ConversationCreateParams;
  acting_user_id?: string;
}

export interface ConversationUpdateCommand {
  type: "conversation_update";
  request_id: string;
  conversation_id: string;
  body: ConversationUpdateParams;
}

export interface ConversationRecompileCommand {
  type: "conversation_recompile";
  request_id: string;
  conversation_id: string;
  body?: ConversationRecompileParams;
}

export interface ConversationForkCommand {
  type: "conversation_fork";
  request_id: string;
  conversation_id: string;
  body?: ConversationForkBody;
  acting_user_id?: string;
}

export interface ConversationMessagesListCommand {
  type: "conversation_messages_list";
  request_id: string;
  conversation_id: string;
  query?: MessageListParams;
}

export interface ConversationCompactCommand {
  type: "conversation_compact";
  request_id: string;
  conversation_id: string;
  body?: MessageCompactParams;
}

export interface GetReflectionSettingsCommand {
  type: "get_reflection_settings";
  request_id: string;
  runtime: AgentRuntimeScope;
}
export interface SetReflectionSettingsCommand {
  type: "set_reflection_settings";
  request_id: string;
  runtime: AgentRuntimeScope;
  settings: {
    trigger: ReflectionTriggerMode;
    step_count: number;
    merge?: ReflectionMergeMode;
    merge_instructions?: string;
  };
  scope?: ReflectionSettingsScope;
}

export interface GetExperimentsCommand {
  type: "get_experiments";
  request_id: string;
}

export interface SetExperimentCommand {
  type: "set_experiment";
  request_id: string;
  experiment_id: ExperimentId;
  enabled: boolean;
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

export interface ChannelAccountCreatePayload {
  account_id?: string;
  display_name?: string;
  enabled?: boolean;
  dm_policy?: DmPolicy;
  allowed_users?: string[];
  config?: ChannelPluginConfig;
}

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
  patch: Omit<ChannelAccountCreatePayload, "account_id">;
}

export interface ChannelAccountBindCommand {
  type: "channel_account_bind";
  request_id: string;
  channel_id: ChannelId;
  account_id: string;
  runtime: AgentRuntimeScope;
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
  config: {
    dm_policy?: DmPolicy;
    allowed_users?: string[];
    plugin_config?: ChannelPluginConfig;
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
  runtime: AgentRuntimeScope;
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
  runtime: AgentRuntimeScope;
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
  runtime: AgentRuntimeScope;
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

export interface AgentListResponseMessage {
  type: "agent_list_response";
  request_id: string;
  success: boolean;
  agents: AgentState[];
  error?: string;
}

export interface AgentRetrieveResponseMessage {
  type: "agent_retrieve_response";
  request_id: string;
  success: boolean;
  agent: AgentState | null;
  error?: string;
}

export interface AgentCreateResponseMessage {
  type: "agent_create_response";
  request_id: string;
  success: boolean;
  agent: AgentState | null;
  error?: string;
}

export interface AgentUpdateResponseMessage {
  type: "agent_update_response";
  request_id: string;
  success: boolean;
  agent: AgentState | null;
  error?: string;
}

export interface AgentDeleteResponseMessage {
  type: "agent_delete_response";
  request_id: string;
  success: boolean;
  agent_id: string;
  error?: string;
}

export interface ConversationListResponseMessage {
  type: "conversation_list_response";
  request_id: string;
  success: boolean;
  conversations: Conversation[];
  error?: string;
}

export interface ConversationRetrieveResponseMessage {
  type: "conversation_retrieve_response";
  request_id: string;
  success: boolean;
  conversation: Conversation | null;
  error?: string;
}

export interface ConversationCreateResponseMessage {
  type: "conversation_create_response";
  request_id: string;
  success: boolean;
  conversation: Conversation | null;
  error?: string;
}

export interface ConversationUpdateResponseMessage {
  type: "conversation_update_response";
  request_id: string;
  success: boolean;
  conversation: Conversation | null;
  error?: string;
}

export interface ConversationRecompileResponseMessage {
  type: "conversation_recompile_response";
  request_id: string;
  success: boolean;
  result: string | null;
  error?: string;
}

export interface ForkedConversationReference {
  id: string;
}

export interface ConversationForkResponseMessage {
  type: "conversation_fork_response";
  request_id: string;
  success: boolean;
  conversation: ForkedConversationReference | null;
  error?: string;
}

export interface ConversationMessagesListResponseMessage {
  type: "conversation_messages_list_response";
  request_id: string;
  success: boolean;
  messages: LettaMessage[];
  next_before: string | null;
  has_more: boolean;
  error?: string;
}

export interface ConversationCompactResponseMessage {
  type: "conversation_compact_response";
  request_id: string;
  success: boolean;
  compaction: CompactionResponse | null;
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

export interface GetExperimentsResponseMessage {
  type: "get_experiments_response";
  request_id: string;
  success: boolean;
  experiments: ExperimentSnapshot[];
  error?: string;
}

export interface SetExperimentResponseMessage {
  type: "set_experiment_response";
  request_id: string;
  success: boolean;
  experiments: ExperimentSnapshot[];
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

export interface GitBranchInfo {
  name: string;
  is_current: boolean;
  is_remote: boolean;
}

export interface SearchBranchesCommand {
  type: "search_branches";
  request_id: string;
  query: string;
  max_results?: number;
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
  request_id: string;
  branch: string;
  create?: boolean;
  cwd?: string;
}

export interface CheckoutBranchResponse {
  type: "checkout_branch_response";
  request_id: string;
  branch: string;
  success: boolean;
  error?: string;
}

export interface SecretListCommand {
  type: "secret_list";
  request_id: string;
  agent_id: string;
}

export interface SecretListResponse {
  type: "secret_list_response";
  request_id: string;
  success: boolean;
  secrets: Array<{ key: string; value: string }>;
  error?: string;
}

export interface SecretApplyCommand {
  type: "secret_apply";
  request_id: string;
  agent_id: string;
  set: Record<string, string>;
  unset: string[];
}

export interface SecretApplyResponse {
  type: "secret_apply_response";
  request_id: string;
  success: boolean;
  names: string[];
  error?: string;
}

export type WsProtocolCommand =
  | TurnFinishedAckCommand
  | InputCommand
  | ChangeDeviceStateCommand
  | AbortMessageCommand
  | import("./queue-update-protocol").ResumeQueueCommand
  | SyncCommand
  | RuntimeStartCommand
  | TeleportProtocol.TeleportProtocolCommand
  | RuntimeExternalToolsUpdateCommand
  | ExternalToolCallResponseCommand
  | TerminalSpawnCommand
  | TerminalInputCommand
  | TerminalResizeCommand
  | TerminalKillCommand
  | SearchFilesCommand
  | GrepInFilesCommand
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
  | MemoryCommitDiffCommand
  | ReadMemoryFileCommand
  | WriteMemoryFileCommand
  | DeleteMemoryFileCommand
  | EnableMemfsCommand
  | ListModelsCommand
  | ListConnectProvidersCommand
  | ConnectProviderCommand
  | DisconnectProviderCommand
  | ChatGPTUsageReadCommand
  | ChatGPTRateLimitResetCreditsListCommand
  | ChatGPTRateLimitResetCreditConsumeCommand
  | UpdateModelCommand
  | UpdateToolsetCommand
  | CronProtocolCommand
  | SkillEnableCommand
  | SkillDisableCommand
  | CreateAgentCommand
  | AppServerInfoCommand
  | AgentListCommand
  | AgentRetrieveCommand
  | AgentCreateCommand
  | AgentUpdateCommand
  | AgentDeleteCommand
  | ConversationListCommand
  | ConversationRetrieveCommand
  | ConversationCreateCommand
  | ConversationUpdateCommand
  | ConversationRecompileCommand
  | ConversationForkCommand
  | ConversationMessagesListCommand
  | ConversationCompactCommand
  | CwdProtocol.SetBootWorkingDirectoryCommand
  | CwdProtocol.GetCwdMapCommand
  | GetReflectionSettingsCommand
  | SetReflectionSettingsCommand
  | GetExperimentsCommand
  | SetExperimentCommand
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
  | TaskControlProtocol.BrowserDeviceMcpOAuthCommand
  | TaskControlProtocol.BrowserDeviceMcpOAuthCancelCommand
  | TaskControlProtocol.ExecuteCommandCommand
  | TaskControlProtocol.RemoveQueueItemCommand
  | SubagentProtocol.LaunchSubagentCommand
  | TaskControlProtocol.MonitorStopCommand
  | SearchBranchesCommand
  | CheckoutBranchCommand
  | SecretListCommand
  | SecretApplyCommand;

export type WsProtocolCommandType = WsProtocolCommand["type"];

export type WsProtocolMessage =
  | TaskControlProtocol.BrowserDeviceMcpOAuthResponseMessage
  | ControlRequest
  | InputAcceptedResponseMessage
  | TeleportProtocol.TeleportProtocolMessage
  | TaskControlProtocol.ExecuteCommandResponseMessage
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | QueueUpdateMessage
  | StreamDeltaMessage
  | TurnFinishedMessage
  | SubagentStateUpdateMessage
  | ExternalToolCallMessage
  | AbortMessageResponseMessage
  | import("./queue-update-protocol").ResumeQueueResponseMessage
  | SyncResponseMessage
  | RuntimeExternalToolsUpdateResponseMessage
  | TerminalOutputMessage
  | TerminalSpawnedMessage
  | TerminalExitedMessage
  | SearchFilesResponseMessage
  | GrepInFilesResponseMessage
  | ListInDirectoryResponseMessage
  | GetTreeResponseMessage
  | ReadFileResponseMessage
  | WriteFileResponseMessage
  | FileOpsCommand
  | EditFileResponseMessage
  | FileChangedMessage
  | ListMemoryResponseMessage
  | MemoryHistoryResponseMessage
  | MemoryFileAtRefResponseMessage
  | MemoryCommitDiffResponseMessage
  | ReadMemoryFileResponseMessage
  | WriteMemoryFileResponseMessage
  | DeleteMemoryFileResponseMessage
  | EnableMemfsResponseMessage
  | MemoryUpdatedMessage
  | ListModelsResponseMessage
  | ListConnectProvidersResponseMessage
  | ConnectProviderResponseMessage
  | DisconnectProviderResponseMessage
  | ChatGPTUsageReadResponseMessage
  | ChatGPTRateLimitResetCreditsListResponseMessage
  | ChatGPTRateLimitResetCreditConsumeResponseMessage
  | UpdateModelResponseMessage
  | UpdateToolsetResponseMessage
  | CronProtocolResponseMessage
  | CronsUpdatedMessage
  | SkillEnableResponseMessage
  | SkillDisableResponseMessage
  | SkillsUpdatedMessage
  | CreateAgentResponseMessage
  | AppServerInfoResponseMessage
  | AgentListResponseMessage
  | AgentRetrieveResponseMessage
  | AgentCreateResponseMessage
  | AgentUpdateResponseMessage
  | AgentDeleteResponseMessage
  | ConversationListResponseMessage
  | ConversationRetrieveResponseMessage
  | ConversationCreateResponseMessage
  | ConversationUpdateResponseMessage
  | ConversationRecompileResponseMessage
  | ConversationForkResponseMessage
  | ConversationMessagesListResponseMessage
  | ConversationCompactResponseMessage
  | RuntimeStartResponseMessage
  | GetExperimentsResponseMessage
  | SetExperimentResponseMessage
  | GetReflectionSettingsResponseMessage
  | SetReflectionSettingsResponseMessage
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
  | ChannelTargetsUpdatedMessage
  | CwdProtocol.SetBootWorkingDirectoryResponseMessage
  | CwdProtocol.GetCwdMapResponseMessage
  | SearchBranchesResponse
  | CheckoutBranchResponse
  | SecretListResponse
  | SecretApplyResponse
  | TaskControlProtocol.RemoveQueueItemResponse
  | TaskControlProtocol.MonitorStopResponse
  | SubagentProtocol.LaunchSubagentResponse;

export type WsProtocolMessageType = WsProtocolMessage["type"];

export type { StopReasonType };
