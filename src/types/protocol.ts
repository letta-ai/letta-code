import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  AssistantMessage as LettaAssistantMessage,
  Message as LettaMessage,
  ReasoningMessage as LettaReasoningMessage,
  LettaStreamingResponse,
  ToolCallMessage as LettaToolCallMessage,
  ToolCall,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { CreateBlock } from "@letta-ai/letta-client/resources/blocks/blocks";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { ToolReturnMessage as LettaToolReturnMessage } from "@letta-ai/letta-client/resources/tools";

export type {
  LettaStreamingResponse,
  LettaMessage,
  ToolCall,
  StopReasonType,
  MessageCreate,
  LettaToolReturnMessage,
  CreateBlock,
};

export interface SystemPromptPresetConfig {
  type: "preset";
  preset: string;
  append?: string;
}

export type SystemPromptConfig = string | SystemPromptPresetConfig;

export interface MessageEnvelope {
  session_id: string;
  uuid: string;
  timestamp?: string;
  event_seq?: number;
  agent_id?: string | null;
  conversation_id?: string;
}

export interface SystemInitMessage extends MessageEnvelope {
  type: "system";
  subtype: "init";
  agent_id: string | null;
  conversation_id: string;
  model: string;
  tools: string[];
  cwd: string;
  mcp_servers: Array<{ name: string; status: string }>;
  permission_mode: string;
  slash_commands: string[];
  memfs_enabled?: boolean;
  skill_sources?: Array<"bundled" | "global" | "agent" | "project">;
  system_info_reminder_enabled?: boolean;
  reflection_trigger?: "off" | "step-count" | "compaction-event";
  reflection_step_count?: number;
}

export type SystemMessage = SystemInitMessage;

export interface AssistantMessageWire
  extends LettaAssistantMessage,
    MessageEnvelope {
  type: "message";
}

export interface ToolCallMessageWire
  extends LettaToolCallMessage,
    MessageEnvelope {
  type: "message";
}

export interface ReasoningMessageWire
  extends LettaReasoningMessage,
    MessageEnvelope {
  type: "message";
}

export interface ToolReturnMessageWire
  extends LettaToolReturnMessage,
    MessageEnvelope {
  type: "message";
}

export type ContentMessage =
  | AssistantMessageWire
  | ToolCallMessageWire
  | ReasoningMessageWire
  | ToolReturnMessageWire;

export type MessageWire = MessageEnvelope & {
  type: "message";
} & LettaStreamingResponse;

export interface StreamEvent extends MessageEnvelope {
  type: "stream_event";
  event: LettaStreamingResponse;
}

export interface ApprovalRequestedMessage extends MessageEnvelope {
  type: "approval_requested";
  request_id: string;
  tool_call_id: string;
  tool_name: string;
  run_id?: string;
}

export interface ApprovalReceivedMessage extends MessageEnvelope {
  type: "approval_received";
  request_id: string;
  tool_call_id: string;
  decision: "allow" | "deny";
  reason?: string;
  run_id?: string;
}

export interface ToolExecutionStartedMessage extends MessageEnvelope {
  type: "tool_execution_started";
  tool_call_id: string;
  run_id?: string;
}

export interface ToolExecutionFinishedMessage extends MessageEnvelope {
  type: "tool_execution_finished";
  tool_call_id: string;
  status: "success" | "error";
  run_id?: string;
}

export interface AutoApprovalMessage extends MessageEnvelope {
  type: "auto_approval";
  tool_call: ToolCall;
  reason: string;
  matched_rule: string;
}

export interface ErrorMessage extends MessageEnvelope {
  type: "error";
  message: string;
  stop_reason: StopReasonType;
  run_id?: string;
  api_error?: LettaStreamingResponse.LettaErrorMessage;
}

export interface RetryMessage extends MessageEnvelope {
  type: "retry";
  reason: StopReasonType;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  run_id?: string;
}

export interface RecoveryMessage extends MessageEnvelope {
  type: "recovery";
  recovery_type:
    | "approval_pending"
    | "approval_desync"
    | "invalid_tool_call_ids";
  message: string;
  run_id?: string;
}

export interface CancelAckMessage extends MessageEnvelope {
  type: "cancel_ack";
  request_id: string;
  accepted: boolean;
  run_id?: string | null;
  reason?: string;
}

export type ResultSubtype = "success" | "interrupted" | "error" | "queued";

export type UsageStatistics = LettaStreamingResponse.LettaUsageStatistics & {
  api_cost_usd?: number | null;
  cache_write_1h_tokens?: number;
};

export interface ResultMessage extends MessageEnvelope {
  type: "result";
  subtype: ResultSubtype;
  agent_id: string | null;
  conversation_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string | null;
  run_ids: string[];
  usage: UsageStatistics | null;
  stop_reason?: StopReasonType;
}

export type QueueItemSource =
  | "user"
  | "task_notification"
  | "cron"
  | "channel"
  | "subagent"
  | "system";

export type QueueItemKind =
  | "message"
  | "task_notification"
  | "cron_prompt"
  | "mod_continue";

export interface QueueRuntimeItemWire {
  id: string;
  client_message_id: string;
  kind: QueueItemKind;
  source: QueueItemSource;
  content: MessageCreate["content"] | string;
  enqueued_at: string;
  paused?: boolean;
}

export interface QueueSnapshotItem
  extends Omit<Partial<QueueRuntimeItemWire>, "kind" | "source"> {
  item_id: string;
  kind: QueueItemKind;
  source: QueueItemSource;
}

export interface QueueItemEnqueuedEvent extends MessageEnvelope {
  type: "queue_item_enqueued";
  id?: string;
  item_id: string;
  client_message_id: QueueRuntimeItemWire["client_message_id"];
  source: QueueItemSource;
  kind: QueueItemKind;
  content?: QueueRuntimeItemWire["content"];
  enqueued_at?: QueueRuntimeItemWire["enqueued_at"];
  queue_len: number;
}

export interface QueueBatchDequeuedEvent extends MessageEnvelope {
  type: "queue_batch_dequeued";
  batch_id: string;
  item_ids: string[];
  merged_count: number;
  queue_len_after: number;
}

export type QueueBlockedReason =
  | "streaming"
  | "pending_approvals"
  | "overlay_open"
  | "command_running"
  | "interrupt_in_progress"
  | "runtime_busy"
  | "paused_by_user";

export interface QueueBlockedEvent extends MessageEnvelope {
  type: "queue_blocked";
  reason: QueueBlockedReason;
  queue_len: number;
}

export type QueueClearedReason =
  | "processed"
  | "error"
  | "cancelled"
  | "shutdown"
  | "stale_generation";

export interface QueueClearedEvent extends MessageEnvelope {
  type: "queue_cleared";
  reason: QueueClearedReason;
  cleared_count: number;
}

export type QueueItemDroppedReason = "buffer_limit" | "stale_generation";

export interface QueueItemDroppedEvent extends MessageEnvelope {
  type: "queue_item_dropped";
  id?: string;
  item_id: string;
  reason: QueueItemDroppedReason;
  queue_len: number;
}

export type QueueLifecycleEvent =
  | QueueItemEnqueuedEvent
  | QueueBatchDequeuedEvent
  | QueueBlockedEvent
  | QueueClearedEvent
  | QueueItemDroppedEvent;

export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
  timestamp?: string;
  agent_id?: string;
  conversation_id?: string;
}

export type SdkToCliControlRequest =
  | { subtype: "initialize" }
  | { subtype: "interrupt" }
  | RegisterExternalToolsRequest
  | BootstrapSessionStateRequest
  | RecoverPendingApprovalsControlRequest
  | ListMessagesControlRequest;

export interface BootstrapSessionStateRequest {
  subtype: "bootstrap_session_state";
  limit?: number;
  order?: "asc" | "desc";
}

export interface BootstrapSessionStatePayload {
  agent_id: string;
  conversation_id: string;
  model: string | undefined;
  tools: string[];
  memfs_enabled: boolean;
  messages: unknown[];
  next_before: string | null;
  has_more: boolean;
  has_pending_approval: boolean;
  timings?: {
    resolve_ms: number;
    list_messages_ms: number;
    total_ms: number;
  };
}

export interface ListMessagesControlRequest {
  subtype: "list_messages";
  conversation_id?: string;
  agent_id?: string;
  before?: string;
  after?: string;
  order?: "asc" | "desc";
  limit?: number;
}

export interface RecoverPendingApprovalsControlRequest {
  subtype: "recover_pending_approvals";
  agent_id?: string;
  conversation_id?: string;
}

export interface RecoverPendingApprovalsResponsePayload {
  recovered: boolean;
  pending_approval: boolean;
  approvals_processed: number;
}

export interface ListMessagesResponsePayload {
  messages: unknown[];
  next_before?: string | null;
  next_after?: string | null;
  has_more?: boolean;
}

export interface RegisterExternalToolsRequest {
  subtype: "register_external_tools";
  tools: ExternalToolDefinition[];
}

export interface ExternalToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
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

export interface CanUseToolControlRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_call_id: string;
  permission_suggestions: unknown[];
  blocked_path: string | null;
  diffs?: DiffPreview[];
}

export interface ExecuteExternalToolRequest {
  subtype: "execute_external_tool";
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export type CliToSdkControlRequest =
  | CanUseToolControlRequest
  | ExecuteExternalToolRequest;

export type ControlRequestBody =
  | SdkToCliControlRequest
  | CliToSdkControlRequest;

export interface ControlResponse extends MessageEnvelope {
  type: "control_response";
  response: ControlResponseBody;
}

export type ControlResponseBody =
  | {
      subtype: "success";
      request_id: string;
      response?:
        | CanUseToolResponse
        | RecoverPendingApprovalsResponsePayload
        | Record<string, unknown>;
    }
  | { subtype: "error"; request_id: string; error: string }
  | ExternalToolResultResponse;

export interface CanUseToolResponseAllow {
  behavior: "allow";
  message?: string;
  updatedInput?: Record<string, unknown> | null;
  updatedPermissions?: unknown[];
}

export interface CanUseToolResponseDeny {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
}

export type CanUseToolResponse =
  | CanUseToolResponseAllow
  | CanUseToolResponseDeny;

export interface ExternalToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface ExternalToolResultResponse {
  subtype: "external_tool_result";
  request_id: string;
  tool_call_id: string;
  content: ExternalToolResultContent[];
  is_error: boolean;
}

export interface UserInput {
  type: "user";
  message: MessageCreate;
}

export interface TranscriptBackfillMessage extends MessageEnvelope {
  type: "transcript_backfill";
  messages: LettaMessage[];
  is_final: boolean;
}

export interface QueueSnapshotMessage extends MessageEnvelope {
  type: "queue_snapshot";
  items: QueueSnapshotItem[];
}

export interface SyncCompleteMessage extends MessageEnvelope {
  type: "sync_complete";
  had_pending_turn: boolean;
}

export interface TranscriptSupplementMessage extends MessageEnvelope {
  type: "transcript_supplement";
  messages: LettaMessage[];
}

export type WireMessage =
  | SystemMessage
  | ContentMessage
  | MessageWire
  | StreamEvent
  | ApprovalRequestedMessage
  | ApprovalReceivedMessage
  | ToolExecutionStartedMessage
  | ToolExecutionFinishedMessage
  | AutoApprovalMessage
  | CancelAckMessage
  | ErrorMessage
  | RetryMessage
  | RecoveryMessage
  | ResultMessage
  | ControlResponse
  | ControlRequest
  | QueueLifecycleEvent
  | TranscriptBackfillMessage
  | QueueSnapshotMessage
  | SyncCompleteMessage
  | TranscriptSupplementMessage;
