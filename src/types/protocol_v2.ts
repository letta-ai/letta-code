/**
 * Protocol V2 (alpha hard-cut contract)
 *
 * This file defines the runtime-scoped websocket contract for device-mode UIs.
 * It is intentionally self-defined and does not import transport/event shapes
 * from the legacy protocol.ts surface.
 */

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

export type DmPolicy = "pairing" | "allowlist" | "open";

export type ExperimentId =
  | "artifacts"
  | "conversation_titles"
  | "desktop_conversation_bootstrap"
  | "diffs"
  | "tui_cron";

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

export type CronTaskStatus = "active" | "fired" | "missed" | "cancelled";
export type CronCancelReason = "conversation_not_found" | "expired";
export type CronRunOutcome = "queued" | "missed" | "failed" | "skipped";
export type CronRunReason =
  | "scheduled_time_matched"
  | "one_off_due"
  | "scheduler_inactive"
  | "started_too_late"
  | "queue_full"
  | "runtime_unavailable"
  | "task_cancelled"
  | "scheduler_error";

export interface CronTask {
  id: string;
  agent_id: string;
  conversation_id: string;
  name: string;
  description: string;
  cron: string;
  timezone: string;
  recurring: boolean;
  prompt: string;
  status: CronTaskStatus;
  created_at: string;
  expires_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: CronCancelReason | null;
  jitter_offset_ms: number;
  last_run_at: string | null;
  last_run_outcome: CronRunOutcome | null;
  last_run_reason: CronRunReason | null;
  last_run_error: string | null;
  last_missed_at: string | null;
  missed_count: number;
  failed_count: number;
  scheduled_for: string | null;
  fired_at: string | null;
  missed_at: string | null;
}

export type CronRunLogStatus = "ok" | "error" | "skipped";

export interface CronRunLogEntry {
  ts: number;
  jobId: string;
  action: "finished";
  status?: CronRunLogStatus;
  outcome?: CronRunOutcome;
  reason?: CronRunReason;
  error?: string;
  summary?: string;
  agentId?: string;
  conversationId?: string;
  runId?: string;
  runAtMs?: number;
  queueItemId?: string;
  scheduledFor?: string | null;
  firedAt?: string;
}

export interface CronRunLogPage {
  entries: CronRunLogEntry[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
}

/**
 * Runtime identity for all state and delta events.
 *
 * `acting_user_id` is set by cloud-api on inbound `input`
 * create_message frames (the WS subscriber's authenticated cloud
 * user id). The listener echoes it back as the
 * `X-Letta-Acting-User-Id` HTTP header on the outbound
 * createMessage call so cloud can attribute credits + rate limits
 * to the actual sender — not the user whose API key happens to
 * spawn the sandbox / desktop runtime. Other event types (state,
 * delta, control) ignore this field.
 */
export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
  acting_user_id?: string;
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

export type DevicePermissionMode = "standard" | "acceptEdits" | "unrestricted";

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

export type ChannelId = string;

export type ChannelPluginConfig = Record<string, unknown>;

// ── Channel config schema (declarative plugin UI) ──

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
  /** Declarative config schema for dynamic settings UI, or null. */
  config_schema: ChannelConfigSchema | null;
}

export interface ChannelConfigSnapshot {
  channel_id: ChannelId;
  account_id: string;
  display_name?: string;
  enabled: boolean;
  dm_policy: DmPolicy;
  allowed_users: string[];
  /** Plugin-owned redacted config/settings payload. */
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
  /** Plugin-owned redacted config/settings payload. */
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
  experiments: ExperimentSnapshot[];
  memory_directory: string | null;
  /**
   * Persisted CWD overrides keyed by listener scope key.
   *
   * Key format:
   * - `conversation:<conversation_id>` for conversation-scoped overrides
   * - `agent:<agent_id>::conversation:default` for an agent's default conversation scope
   *
   * Example: `conversation:conv_123` or `agent:agent_123::conversation:default`
   */
  cwd_map?: Record<string, string>;
  /** Listener boot CWD used when a conversation has no matching formatted key in `cwd_map`. */
  boot_working_directory?: string | null;
  should_doctor?: boolean;
  reflection_settings: ReflectionSettingsSnapshot | null;
  /** Remote slash command IDs this letta-code version can handle via `execute_command`. */
  supported_commands: string[];
  /**
   * Slash commands contributed by locally loaded mods. Advertised separately
   * from `supported_commands` (which gates the client's built-in allowlist) so
   * clients can auto-surface mod commands by their own policy. Invoked through
   * the same `execute_command` path. Omitted when no mod commands are loaded.
   */
  mod_commands?: ModCommandInfo[];
}

/** A mod-contributed slash command advertised to clients for rendering. */
export interface ModCommandInfo {
  id: string;
  description: string;
  /** Optional argument hint shown in the palette (e.g. "<query>"). */
  args?: string;
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
  | "overlay_action"
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
  prompt?: string;
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
  /**
   * Optional request-scoped allowlist for locally executed client tools.
   * Undefined preserves the listener's normal toolset; an empty array means no
   * client tools for this turn.
   */
  client_tool_allowlist?: string[];
  /**
   * Optional scoped external tools to expose for this turn. Runtime-start
   * external tools with a scope_id stay hidden unless selected here; unscoped
   * external tools for the runtime remain available normally.
   */
  external_tool_scope_ids?: string[];
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
  /** When provided, app-server sends abort_message_response on the control channel. */
  request_id?: string;
  run_id?: string | null;
}

export interface SyncCommand {
  type: "sync";
  runtime: RuntimeScope;
  /** When provided, app-server sends sync_response after replaying state. */
  request_id?: string;
  /**
   * Whether the device should probe backend state for stale pending approvals.
   * Defaults to true for older clients. Lightweight status/recovery syncs should
   * set this false and only replay in-memory listener state.
   */
  recover_approvals?: boolean;
  /**
   * Force the sync replay to include update_device_status even when the
   * listener's last device-status snapshot for this socket/scope is unchanged.
   */
  force_device_status?: boolean;
}

export interface RuntimeStartCreateAgentOptions {
  /** Body forwarded to the Letta agents create API. */
  body: AgentCreateParams;
  /** Whether to pin the created agent globally. Defaults to true. */
  pin_global?: boolean;
}

export interface RuntimeStartCreateConversationOptions {
  /** Body forwarded to the Letta conversations create API. */
  body?: Omit<ConversationCreateParams, "agent_id">;
}

export interface RuntimeStartClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface ExternalToolDefinitionPayload {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RuntimeStartExternalToolsGroup {
  /** Hidden controller-defined scope used to select these tools on input turns. */
  scope_id?: string;
  tools: readonly ExternalToolDefinitionPayload[];
}

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
  /** Create a new conversation for the resolved agent before starting the runtime. */
  create_conversation?: RuntimeStartCreateConversationOptions;
  /** Initial working directory for this runtime scope. Null resets to listener boot CWD. */
  cwd?: string | null;
  /** Initial permission mode for this runtime scope. */
  mode?: DevicePermissionMode;
  /** Optional client metadata for diagnostics/future protocol negotiation. */
  client_info?: RuntimeStartClientInfo;
  /** Whether to probe backend state for stale pending approvals before replaying state. Defaults to true. */
  recover_approvals?: boolean;
  /** Force the initial state replay to include update_device_status. Defaults to true. */
  force_device_status?: boolean;
  /** Controller-owned tools registered atomically with the resolved runtime. */
  external_tools?: readonly RuntimeStartExternalToolsGroup[];
}

export interface ExternalToolCallRequestMessage {
  type: "external_tool_call_request";
  request_id: string;
  runtime?: RuntimeScope;
  scope_id?: string;
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ExternalToolCallResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ExternalToolCallResult {
  content: readonly ExternalToolCallResultContent[];
  is_error?: boolean;
}

export interface ExternalToolCallResponseCommand {
  type: "external_tool_call_response";
  request_id: string;
  result?: ExternalToolCallResult;
  error?: string;
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
  runtime: RuntimeScope;
  /** True when an active turn or pending approval was interrupted. */
  aborted: boolean;
  success: boolean;
  error?: string;
}

export interface SyncResponseMessage {
  type: "sync_response";
  request_id: string;
  runtime: RuntimeScope;
  success: boolean;
  error?: string;
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

/**
 * Listener command — IntelliJ-style "find in files" content search.
 * Returns line-level matches (text + line/column range) instead of
 * just the file list so the client can render an IDE-grade results
 * pane with snippet previews.
 */
export interface GrepInFilesCommand {
  type: "grep_in_files";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Literal or regex pattern depending on `is_regex`. */
  query: string;
  /** When true, `query` is treated as a regex. Defaults to false. */
  is_regex?: boolean;
  /** Case-sensitive match. Defaults to false. */
  case_sensitive?: boolean;
  /** Whole-word match. Defaults to false. */
  whole_word?: boolean;
  /** Glob filter (e.g. "*.tsx" or "src/** /*.ts"). Empty = no filter. */
  glob?: string;
  /** Scope search to this absolute dir. Falls back to the index root. */
  cwd?: string;
  /** Max match lines returned (not files). Defaults to 500. */
  max_results?: number;
  /** Lines of context before/after each match. Defaults to 2. */
  context_lines?: number;
}

export interface GrepInFilesMatch {
  /** Path relative to the search root. */
  path: string;
  /** 1-based line number of the matched line. */
  line: number;
  /** 1-based column (character offset of match start, inclusive). */
  column: number;
  /** 1-based column of match end (exclusive). */
  column_end: number;
  /** The full matched line's text (no trailing newline). */
  text: string;
  /** Lines immediately before the match (up to context_lines). */
  before?: string[];
  /** Lines immediately after the match (up to context_lines). */
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
  /** Absolute path to the root of the subtree to fetch. */
  path: string;
  /** Maximum depth of the subtree to return (e.g. 3). */
  depth: number;
  /** Echoed back in the response for request correlation. */
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
  /** Absolute path to the file to read. */
  path: string;
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface ReadFileResponseMessage {
  type: "read_file_response";
  request_id: string;
  path: string;
  content: string | null;
  success: boolean;
  error?: string;
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

export interface WriteFileResponseMessage {
  type: "write_file_response";
  request_id: string;
  path: string;
  success: boolean;
  error?: string;
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
  /** Relative path within the memory directory (e.g. "system/persona.md"). Omit for global history across all files. */
  file_path?: string;
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

/** Read a file from the agent's MemFS working tree. Use base64 for binary. */
export interface ReadMemoryFileCommand {
  type: "read_memory_file";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory to read. */
  agent_id: string;
  /** Relative to the memory root. */
  path: string;
  /** Defaults to "utf8". */
  encoding?: "utf8" | "base64";
}

/**
 * Write a file into the agent's MemFS and commit.
 *
 * Use for agent memory writes (e.g. profile images). Path is
 * relative to the memory root and is rejected if it escapes the root.
 */
export interface WriteMemoryFileCommand {
  type: "write_memory_file";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory to write to. */
  agent_id: string;
  /** Relative path within the memory directory (e.g. "profile.png"). */
  path: string;
  /** Content to write — utf8 string or base64-encoded bytes. */
  content: string;
  /** Encoding of `content`. Defaults to "utf8". */
  encoding?: "utf8" | "base64";
  /** Optional commit message; defaults to a sensible fallback. */
  commit_message?: string;
}

/**
 * Delete a single file from the agent's MemFS working tree and commit
 * the deletion. Idempotent: if the file is already absent, the handler
 * returns success without producing a commit.
 */
export interface DeleteMemoryFileCommand {
  type: "delete_memory_file";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory to delete from. */
  agent_id: string;
  /** Relative path within the memory directory. */
  path: string;
  /** Optional commit message; defaults to a sensible fallback. */
  commit_message?: string;
}

export interface MemoryCommitDiffCommand {
  type: "memory_commit_diff";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent whose memory to read. */
  agent_id: string;
  /** Git SHA of the commit to show. */
  sha: string;
}

export interface EnableMemfsCommand {
  type: "enable_memfs";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** The agent to enable memfs for. */
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
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /**
   * Bypass the listener's availability cache and refetch from the backend.
   * Sent by user-initiated refreshes so they can never be answered with a
   * stale-but-within-TTL snapshot.
   */
  force?: boolean;
}

export type ConnectProviderStorageTarget = "local";
export type ChatGPTUsageReadTarget = "local" | "api";

export interface ListConnectProvidersCommand {
  type: "list_connect_providers";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Provider store to inspect. MVP supports local provider storage. */
  target: ConnectProviderStorageTarget;
}

export interface ConnectProviderCommand {
  type: "connect_provider";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Provider store to write. MVP supports local provider storage. */
  target: ConnectProviderStorageTarget;
  /** Provider id from list_connect_providers. */
  provider_id: string;
  /** Optional auth method id for providers with multiple auth methods. */
  auth_method_id?: string;
  /** User-provided connection fields keyed by field id. */
  fields: Record<string, string>;
}

export interface DisconnectProviderCommand {
  type: "disconnect_provider";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Provider store to write. MVP supports local provider storage. */
  target: ConnectProviderStorageTarget;
  /** Provider id from list_connect_providers. */
  provider_id: string;
  /** Optional connected provider name to remove when a row has multiple aliases. */
  provider_name?: string;
}

export interface ChatGPTUsageReadCommand {
  type: "chatgpt_usage_read";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Provider store to inspect. */
  target: ChatGPTUsageReadTarget;
  /** Optional connected ChatGPT provider alias. Defaults to the built-in alias. */
  provider_name?: string;
  /** Skip the short listener-side cache. */
  force_refresh?: boolean;
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
  /** First connected provider, preserved for older clients. */
  connected: ConnectProviderConnectionState;
  /** All connected provider aliases represented by this row. */
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

export interface ChatGPTUsageWindowPayload {
  label: string;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ChatGPTUsageCreditsPayload {
  balance?: string | null;
  availableCount?: number | null;
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
}

export interface ChatGPTUsageIndividualLimitPayload {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

export interface ChatGPTUsageSnapshotPayload {
  providerName: string;
  fetchedAt: string;
  summary: string;
  planType?: string | null;
  limitReached?: boolean | null;
  rateLimitReachedType?: string | null;
  primary: ChatGPTUsageWindowPayload | null;
  secondary: ChatGPTUsageWindowPayload | null;
  additional: ChatGPTUsageWindowPayload[];
  credits?: ChatGPTUsageCreditsPayload | null;
  individualLimit?: ChatGPTUsageIndividualLimitPayload | null;
}

export interface ChatGPTUsageReadErrorPayload {
  code:
    | "bad_request"
    | "not_connected"
    | "unsupported_target"
    | "refresh_failed"
    | "unauthorized"
    | "forbidden"
    | "rate_limited"
    | "network_error"
    | "bad_response";
  message: string;
  retryAfterMs?: number;
}

export interface ChatGPTUsageReadResponseMessage {
  type: "chatgpt_usage_read_response";
  request_id: string;
  success: boolean;
  target: ChatGPTUsageReadTarget;
  usage?: ChatGPTUsageSnapshotPayload;
  error?: ChatGPTUsageReadErrorPayload;
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

export interface UpdateToolsetCommand {
  type: "update_toolset";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Runtime scope — identifies which agent + conversation this targets */
  runtime: RuntimeScope;
  /** The toolset preference to apply (e.g. "auto", "default", "codex", "gemini") */
  toolset_preference: ToolsetPreference;
}

export interface UpdateToolsetResponseMessage {
  type: "update_toolset_response";
  request_id: string;
  success: boolean;
  runtime?: RuntimeScope;
  current_toolset?: ToolsetName;
  current_toolset_preference?: ToolsetPreference;
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
  /**
   * Conversation target for scheduled fires.
   * - omitted/"default": agent default conversation
   * - "new": create a fresh conversation for every fire
   * - any other string: existing conversation id
   */
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

export interface CronRunsCommand {
  type: "cron_runs";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
  /** Maximum run-log entries to return. */
  limit?: number;
  /** Page offset for run-log entries. */
  offset?: number;
  /** Optional run id filter. */
  run_id?: string;
}

export interface CronTriggerCommand {
  type: "cron_trigger";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
}

export interface CronUpdateCommand {
  type: "cron_update";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  task_id: string;
  name?: string;
  description?: string;
  conversation_id?: string;
  cron?: string;
  timezone?: string;
  recurring?: boolean;
  prompt?: string;
  /** Optional ISO timestamp for one-shot tasks. */
  scheduled_for?: string | null;
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

export interface SkillEnableResponseMessage {
  type: "skill_enable_response";
  request_id: string;
  success: boolean;
  skill_name?: string;
  error?: string;
}

export interface SkillDisableCommand {
  type: "skill_disable";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Skill name (symlink name in ~/.letta/skills/). */
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
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Built-in personality preset to create. */
  personality: "memo" | "tutorial" | "blank" | "linus" | "kawaii";
  /** Model identifier (e.g. "sonnet", "gpt-4o"). Uses default if omitted. */
  model?: string;
  /** Whether to pin the agent globally after creation. Defaults to true. */
  pin_global?: boolean;
}

export interface AgentListCommand {
  type: "agent_list";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Query params forwarded to the Letta agents list API. */
  query?: AgentListParams;
}

export interface AgentRetrieveCommand {
  type: "agent_retrieve";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
}

export interface AgentCreateCommand {
  type: "agent_create";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Body forwarded to the Letta agents create API. */
  body: AgentCreateParams;
}

export interface AgentUpdateCommand {
  type: "agent_update";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
  /** Body forwarded to the Letta agents update API. */
  body: AgentUpdateParams;
}

export interface AgentDeleteCommand {
  type: "agent_delete";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  agent_id: string;
}

export interface ConversationListCommand {
  type: "conversation_list";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Query params forwarded to the Letta conversations list API. */
  query?: ConversationListParams;
}

export interface ConversationRetrieveCommand {
  type: "conversation_retrieve";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
}

export interface ConversationCreateCommand {
  type: "conversation_create";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  /** Body forwarded to the Letta conversations create API. */
  body: ConversationCreateParams;
  /**
   * Set by cloud-api when relaying the command: the authenticated WS
   * subscriber's cloud user id. The listener echoes it back as the
   * `X-Letta-Acting-User-Id` HTTP header on the outbound
   * conversations.create call so cloud attributes the new conversation
   * to the human who actually created it — not the user whose API key
   * spawned the sandbox / desktop runtime. Absent for self-hosted or
   * direct (non-relayed) flows.
   */
  acting_user_id?: string;
}

export interface ConversationUpdateCommand {
  type: "conversation_update";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
  /** Body forwarded to the Letta conversations update API. */
  body: ConversationUpdateParams;
}

export interface ConversationRecompileCommand {
  type: "conversation_recompile";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
  /** Body/query forwarded to the Letta conversations recompile API. */
  body?: ConversationRecompileParams;
}

export interface ConversationForkBody {
  /** Agent ID for agent-direct mode with the default conversation. */
  agent_id?: string | null;
  /** Whether the forked conversation should be hidden. */
  hidden?: boolean;
}

export interface ConversationForkCommand {
  type: "conversation_fork";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
  body?: ConversationForkBody;
  /**
   * Set by cloud-api when relaying the command — see
   * `ConversationCreateCommand.acting_user_id`. The fork produces a new
   * conversation, so it is attributed the same way.
   */
  acting_user_id?: string;
}

export interface ConversationMessagesListCommand {
  type: "conversation_messages_list";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
  /** Query params forwarded to the Letta conversation messages list API. */
  query?: MessageListParams;
}

export interface ConversationCompactCommand {
  type: "conversation_compact";
  /** Echoed back in the response for request correlation. */
  request_id: string;
  conversation_id: string;
  /** Body forwarded to the Letta conversation messages compact API. */
  body?: MessageCompactParams;
}

export interface GetCwdMapCommand {
  type: "get_cwd_map";
  /** Echoed back in the response for request correlation. */
  request_id: string;
}

export interface GetCwdMapResponseMessage {
  type: "get_cwd_map_response";
  request_id: string;
  success: boolean;
  /** Persisted per-conversation CWD overrides, keyed by listener scope key. */
  cwd_map: Record<string, string>;
  /** Listener boot CWD used when a conversation has no entry in cwd_map. */
  boot_working_directory: string | null;
  error?: string;
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
  /** Plugin-owned account config. New fields should be added here, not centrally. */
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

export interface CronRunsResponseMessage {
  type: "cron_runs_response";
  request_id: string;
  success: boolean;
  page?: CronRunLogPage;
  error?: string;
}

export interface CronTriggerResponseMessage {
  type: "cron_trigger_response";
  request_id: string;
  success: boolean;
  found: boolean;
  task?: CronTask;
  error?: string;
}

export interface CronUpdateResponseMessage {
  type: "cron_update_response";
  request_id: string;
  success: boolean;
  task?: CronTask;
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
  error?: string;
}

export interface ConversationCompactResponseMessage {
  type: "conversation_compact_response";
  request_id: string;
  success: boolean;
  compaction: CompactionResponse | null;
  error?: string;
}

export interface RuntimeStartResponseMessage {
  type: "runtime_start_response";
  request_id: string;
  success: boolean;
  runtime: RuntimeScope | null;
  agent: AgentState | null;
  conversation: Conversation | null;
  created: {
    agent: boolean;
    conversation: boolean;
  };
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
//  Queue item commands
// ─────────────────────────────────────────────────

/**
 * Remove a specific item from the queue by ID.
 * Used by desktop to implement queue editing (load into input, remove from queue).
 */
export interface RemoveQueueItemCommand {
  type: "remove_queue_item";
  /** Correlation id (echoed back in the response for request correlation). */
  request_id: string;
  /** Runtime scope — identifies which agent + conversation this targets. */
  runtime: RuntimeScope;
  /** The queue item ID to remove. */
  item_id: string;
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

// ─────────────────────────────────────────────────
//  Secrets management (modal + CLI source of truth)
//
//  letta-code owns the secrets cache. All reads and writes go through these
//  three commands so the in-memory cache stays consistent. Per-turn
//  hydration is one-shot — these commands are the only paths that re-touch
//  core after the initial fetch.
// ─────────────────────────────────────────────────

/**
 * Refresh the local secrets cache from core and return the available
 * secrets. The modal needs the plaintext values to populate the form, so
 * this command intentionally exposes them. The CLI's `/secret list` uses a
 * separate code path that returns names only.
 */
export interface SecretListCommand {
  type: "secret_list";
  request_id: string;
  /** Agent whose secrets to list. */
  agent_id: string;
}

export interface SecretListResponse {
  type: "secret_list_response";
  request_id: string;
  success: boolean;
  /** Sorted secret entries (key + plaintext value). Empty on failure. */
  secrets: Array<{ key: string; value: string }>;
  error?: string;
}

/**
 * Apply a batch of secret mutations atomically. The device computes the
 * resulting map (current ∪ set) ∖ unset and PATCHes core in a single call,
 * eliminating the read-modify-write race that would plague parallel
 * per-key calls. This is the only WS-surfaced write — single-key set/unset
 * are CLI-only via `setSecretOnServer` / `deleteSecretOnServer`.
 *
 * Keys provided in `set` override any existing values; `unset` keys are
 * removed from the final map. Keys appearing in both lists resolve to
 * `unset` (defensive — clients shouldn't send both).
 */
export interface SecretApplyCommand {
  type: "secret_apply";
  request_id: string;
  agent_id: string;
  /** Keys to add or replace, with their plaintext values. */
  set: Record<string, string>;
  /** Keys to remove. Normalized to uppercase server-side. */
  unset: string[];
}

export interface SecretApplyResponse {
  type: "secret_apply_response";
  request_id: string;
  success: boolean;
  /** Sorted secret names after the apply. Empty on failure. */
  names: string[];
  error?: string;
}

export interface RemoveQueueItemResponse {
  type: "remove_queue_item_response";
  request_id: string;
  success: boolean;
  item_id: string;
}

export type WsProtocolCommand =
  | InputCommand
  | ChangeDeviceStateCommand
  | AbortMessageCommand
  | SyncCommand
  | RuntimeStartCommand
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
  | UpdateModelCommand
  | UpdateToolsetCommand
  | CronListCommand
  | CronAddCommand
  | CronGetCommand
  | CronRunsCommand
  | CronTriggerCommand
  | CronUpdateCommand
  | CronDeleteCommand
  | CronDeleteAllCommand
  | SkillEnableCommand
  | SkillDisableCommand
  | CreateAgentCommand
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
  | GetCwdMapCommand
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
  | ExecuteCommandCommand
  | RemoveQueueItemCommand
  | SearchBranchesCommand
  | CheckoutBranchCommand
  | SecretListCommand
  | SecretApplyCommand;

export type WsProtocolCommandType = WsProtocolCommand["type"];

export type WsProtocolMessage =
  | ControlRequest
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | QueueUpdateMessage
  | StreamDeltaMessage
  | SubagentStateUpdateMessage
  | ExternalToolCallRequestMessage
  | AbortMessageResponseMessage
  | SyncResponseMessage
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
  | UpdateModelResponseMessage
  | UpdateToolsetResponseMessage
  | CronListResponseMessage
  | CronAddResponseMessage
  | CronGetResponseMessage
  | CronRunsResponseMessage
  | CronTriggerResponseMessage
  | CronUpdateResponseMessage
  | CronDeleteResponseMessage
  | CronDeleteAllResponseMessage
  | CronsUpdatedMessage
  | SkillEnableResponseMessage
  | SkillDisableResponseMessage
  | SkillsUpdatedMessage
  | CreateAgentResponseMessage
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
  | GetCwdMapResponseMessage
  | SearchBranchesResponse
  | CheckoutBranchResponse
  | SecretListResponse
  | SecretApplyResponse
  | RemoveQueueItemResponse;

export type WsProtocolMessageType = WsProtocolMessage["type"];

export type { StopReasonType };
