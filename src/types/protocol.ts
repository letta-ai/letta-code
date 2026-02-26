/**
 * Protocol Types for Letta Code
 *
 * These types define:
 * 1. The JSON structure emitted by headless.ts in stream-json mode (wire protocol)
 * 2. Configuration types for session options (used internally and by SDK)
 *
 * Design principle: Compose from @letta-ai/letta-client types where possible.
 */

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

// Re-export letta-client types that consumers may need
export type {
  LettaStreamingResponse,
  LettaMessage,
  ToolCall,
  StopReasonType,
  MessageCreate,
  LettaToolReturnMessage,
  CreateBlock,
};

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION TYPES (session options)
// Used internally by headless.ts/App.tsx, also exported for SDK
// ═══════════════════════════════════════════════════════════════

/**
 * System prompt preset configuration.
 * Use this to select a built-in system prompt with optional appended text.
 *
 * Available presets (validated at runtime by CLI):
 * - 'default' - Alias for letta-claude
 * - 'letta-claude' - Full Letta Code prompt (Claude-optimized)
 * - 'letta-codex' - Full Letta Code prompt (Codex-optimized)
 * - 'letta-gemini' - Full Letta Code prompt (Gemini-optimized)
 * - 'claude' - Basic Claude (no skills/memory instructions)
 * - 'codex' - Basic Codex (no skills/memory instructions)
 * - 'gemini' - Basic Gemini (no skills/memory instructions)
 */
export interface SystemPromptPresetConfig {
  type: "preset";
  /** Preset ID (e.g., 'default', 'letta-codex'). Validated at runtime. */
  preset: string;
  /** Additional instructions to append to the preset */
  append?: string;
}

/**
 * System prompt configuration - either a raw string or preset config.
 * - string: Use as the complete system prompt
 * - SystemPromptPresetConfig: Use a preset, optionally with appended text
 */
export type SystemPromptConfig = string | SystemPromptPresetConfig;

// ═══════════════════════════════════════════════════════════════
// BASE ENVELOPE
// All wire messages include these fields
// ═══════════════════════════════════════════════════════════════

export interface MessageEnvelope {
  session_id: string;
  uuid: string;
}

// ═══════════════════════════════════════════════════════════════
// SYSTEM MESSAGES
// ═══════════════════════════════════════════════════════════════

export interface SystemInitMessage extends MessageEnvelope {
  type: "system";
  subtype: "init";
  agent_id: string;
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
  reflection_behavior?: "reminder" | "auto-launch";
  reflection_step_count?: number;
  // output_style omitted - Letta Code doesn't have output styles feature
}

export type SystemMessage = SystemInitMessage;

// ═══════════════════════════════════════════════════════════════
// CONTENT MESSAGES
// These wrap letta-client message types with the wire envelope
// ═══════════════════════════════════════════════════════════════

/**
 * Wire format for assistant messages.
 * Extends LettaAssistantMessage with wire envelope fields.
 */
export interface AssistantMessageWire
  extends LettaAssistantMessage,
    MessageEnvelope {
  type: "message";
}

/**
 * Wire format for tool call messages.
 * Extends LettaToolCallMessage with wire envelope fields.
 */
export interface ToolCallMessageWire
  extends LettaToolCallMessage,
    MessageEnvelope {
  type: "message";
}

/**
 * Wire format for reasoning messages.
 * Extends LettaReasoningMessage with wire envelope fields.
 */
export interface ReasoningMessageWire
  extends LettaReasoningMessage,
    MessageEnvelope {
  type: "message";
}

/**
 * Wire format for tool return messages.
 * Extends LettaToolReturnMessage with wire envelope fields.
 */
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

/**
 * Generic message wrapper for spreading LettaStreamingResponse chunks.
 * Used when the exact message type is determined at runtime.
 */
export type MessageWire = {
  type: "message";
  session_id: string;
  uuid: string;
} & LettaStreamingResponse;

// ═══════════════════════════════════════════════════════════════
// STREAM EVENTS (partial message updates)
// ═══════════════════════════════════════════════════════════════

export interface StreamEvent extends MessageEnvelope {
  type: "stream_event";
  event: LettaStreamingResponse;
}

// ═══════════════════════════════════════════════════════════════
// AUTO APPROVAL
// ═══════════════════════════════════════════════════════════════

export interface AutoApprovalMessage extends MessageEnvelope {
  type: "auto_approval";
  tool_call: ToolCall;
  reason: string;
  matched_rule: string;
}

// ═══════════════════════════════════════════════════════════════
// ERROR & RETRY
// ═══════════════════════════════════════════════════════════════

export interface ErrorMessage extends MessageEnvelope {
  type: "error";
  /** High-level error message from the CLI */
  message: string;
  stop_reason: StopReasonType;
  run_id?: string;
  /** Nested API error when the error originated from Letta API */
  api_error?: LettaStreamingResponse.LettaErrorMessage;
}

export interface RetryMessage extends MessageEnvelope {
  type: "retry";
  /** The stop reason that triggered the retry. Uses StopReasonType from letta-client. */
  reason: StopReasonType;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  run_id?: string;
}

/**
 * Recovery message emitted when the CLI detects and recovers from errors.
 * Used for approval state conflicts and other recoverable errors.
 */
export interface RecoveryMessage extends MessageEnvelope {
  type: "recovery";
  /** Type of recovery performed */
  recovery_type:
    | "approval_pending"
    | "approval_desync"
    | "invalid_tool_call_ids";
  /** Human-readable description of what happened */
  message: string;
  run_id?: string;
}

// ═══════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════

/**
 * Result subtypes.
 * For errors, use stop_reason field with StopReasonType from letta-client.
 */
export type ResultSubtype = "success" | "interrupted" | "error";

/**
 * Usage statistics from letta-client.
 * Re-exported for convenience.
 */
export type UsageStatistics = LettaStreamingResponse.LettaUsageStatistics;

export interface ResultMessage extends MessageEnvelope {
  type: "result";
  subtype: ResultSubtype;
  agent_id: string;
  conversation_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string | null;
  run_ids: string[];
  usage: UsageStatistics | null;
  /**
   * Present when subtype is "error".
   * Uses StopReasonType from letta-client (e.g., 'error', 'max_steps', 'llm_api_error').
   */
  stop_reason?: StopReasonType;
}

// ═══════════════════════════════════════════════════════════════
// QUEUE LIFECYCLE
// Events emitted by the shared queue runtime. Each describes a
// discrete state transition in the turn queue. Consumers (TUI,
// headless bidir JSON, WS listen) emit these through their
// respective output channels.
// ═══════════════════════════════════════════════════════════════

/**
 * Source that produced the queue item.
 * - user: Submitted via Enter in TUI or stdin in headless
 * - task_notification: Background subagent completion
 * - subagent: Direct subagent result
 * - system: Approval results, overlay actions, system reminders
 */
export type QueueItemSource =
  | "user"
  | "task_notification"
  | "subagent"
  | "system";

/**
 * Kind of content carried by the queue item.
 * - message: User or system text to send to the agent
 * - task_notification: Background task completed notification
 * - approval_result: Tool approval/denial result
 * - overlay_action: Plan mode, AskUserQuestion, etc.
 */
export type QueueItemKind =
  | "message"
  | "task_notification"
  | "approval_result"
  | "overlay_action";

/**
 * Emitted synchronously when an item enters the queue.
 * A queue item is a discrete, submitted unit of work (post-Enter for user
 * messages, or a delivered notification/result for system sources).
 */
export interface QueueItemEnqueuedEvent extends MessageEnvelope {
  type: "queue_item_enqueued";
  item_id: string;
  source: QueueItemSource;
  kind: QueueItemKind;
  queue_len: number;
}

/**
 * Emitted exactly once when the runtime dequeues a batch for submission.
 * Contiguous coalescable items (user + task messages) are merged into one batch.
 */
export interface QueueBatchDequeuedEvent extends MessageEnvelope {
  type: "queue_batch_dequeued";
  batch_id: string;
  item_ids: string[];
  merged_count: number;
  queue_len_after: number;
}

/**
 * Why the queue cannot dequeue right now.
 * - streaming: Agent turn is actively streaming
 * - pending_approvals: Waiting for HITL approval decisions
 * - overlay_open: Plan mode, AskUserQuestion, or other overlay is active
 * - command_running: Slash command is executing
 * - interrupt_in_progress: User interrupt (Esc) is being processed
 * - runtime_busy: Generic busy state (e.g., listen-client turn in flight)
 */
export type QueueBlockedReason =
  | "streaming"
  | "pending_approvals"
  | "overlay_open"
  | "command_running"
  | "interrupt_in_progress"
  | "runtime_busy";

/**
 * Emitted only on blocked-reason state transitions (not on every dequeue
 * check while blocked). The runtime tracks lastEmittedBlockedReason and
 * fires this only when the reason changes or transitions from unblocked.
 */
export interface QueueBlockedEvent extends MessageEnvelope {
  type: "queue_blocked";
  reason: QueueBlockedReason;
  queue_len: number;
}

/**
 * Why the queue was cleared.
 */
export type QueueClearedReason =
  | "processed"
  | "error"
  | "cancelled"
  | "shutdown"
  | "stale_generation";

/**
 * Emitted when the queue is flushed due to a terminal condition.
 */
export interface QueueClearedEvent extends MessageEnvelope {
  type: "queue_cleared";
  reason: QueueClearedReason;
  cleared_count: number;
}

/**
 * Why an item was dropped without processing.
 */
export type QueueItemDroppedReason = "buffer_limit" | "stale_generation";

/**
 * Emitted when an item is dropped from the queue without being processed.
 */
export interface QueueItemDroppedEvent extends MessageEnvelope {
  type: "queue_item_dropped";
  item_id: string;
  reason: QueueItemDroppedReason;
  queue_len: number;
}

/**
 * Union of all queue lifecycle events.
 */
export type QueueLifecycleEvent =
  | QueueItemEnqueuedEvent
  | QueueBatchDequeuedEvent
  | QueueBlockedEvent
  | QueueClearedEvent
  | QueueItemDroppedEvent;

// ═══════════════════════════════════════════════════════════════
// CONTROL PROTOCOL
// Bidirectional: SDK → CLI and CLI → SDK both use control_request/response
// ═══════════════════════════════════════════════════════════════

// --- Control Request (bidirectional) ---
export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
}

// SDK → CLI request subtypes
export type SdkToCliControlRequest =
  | { subtype: "initialize" }
  | { subtype: "interrupt" }
  | RegisterExternalToolsRequest
  | BootstrapSessionStateRequest
  | ListMessagesControlRequest;

/**
 * Request to bootstrap session state (SDK → CLI).
 * Returns resolved session metadata, initial history page, and optional pending
 * approval snapshot — all in a single round-trip to minimise cold-open latency.
 */
export interface BootstrapSessionStateRequest {
  subtype: "bootstrap_session_state";
  /** Max messages to include in the initial history page. Defaults to 50. */
  limit?: number;
  /** Sort order for initial history page. Defaults to "desc". */
  order?: "asc" | "desc";
}

/**
 * Successful bootstrap_session_state response payload.
 */
export interface BootstrapSessionStatePayload {
  /** Resolved agent ID for this session. */
  agent_id: string;
  /** Resolved conversation ID for this session. */
  conversation_id: string;
  /** LLM model handle. */
  model: string | undefined;
  /** Tool names registered on the agent. */
  tools: string[];
  /** Whether memfs (git-backed memory) is enabled. */
  memfs_enabled: boolean;
  /** Initial history page (same shape as list_messages response). */
  messages: unknown[];
  /** Cursor to fetch older messages (null if none). */
  next_before: string | null;
  /** Whether more history pages exist. */
  has_more: boolean;
  /** Whether there is a pending approval waiting for a response. */
  has_pending_approval: boolean;
  /** Optional wall-clock timings in milliseconds. */
  timings?: {
    /** Time to resolve agent + conversation context. */
    resolve_ms: number;
    /** Time to fetch the initial message page. */
    list_messages_ms: number;
    /** Total bootstrap wall-clock time. */
    total_ms: number;
  };
}

/**
 * Request to list conversation messages (SDK → CLI).
 * Returns paginated messages from a specific conversation.
 */
export interface ListMessagesControlRequest {
  subtype: "list_messages";
  /** Explicit conversation ID (e.g. "conv-123"). */
  conversation_id?: string;
  /** Use the agent's default conversation. */
  agent_id?: string;
  /** Cursor: return messages before this message ID. */
  before?: string;
  /** Cursor: return messages after this message ID. */
  after?: string;
  /** Sort order. Defaults to "desc" (newest first). */
  order?: "asc" | "desc";
  /** Max messages to return. Defaults to 50. */
  limit?: number;
}

/**
 * Successful list_messages response payload.
 */
export interface ListMessagesResponsePayload {
  messages: unknown[]; // Raw API Message objects
  next_before?: string | null;
  next_after?: string | null;
  has_more?: boolean;
}

/**
 * Request to register external tools (SDK → CLI)
 * External tools are executed by the SDK, not the CLI.
 */
export interface RegisterExternalToolsRequest {
  subtype: "register_external_tools";
  tools: ExternalToolDefinition[];
}

/**
 * External tool definition (from SDK)
 */
export interface ExternalToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// --- Diff preview types (wire-safe, no CLI imports) ---

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

// CLI → SDK request subtypes
export interface CanUseToolControlRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, unknown>;
  tool_call_id: string; // Letta-specific: needed to track the tool call
  /** TODO: Not implemented - suggestions for permission updates */
  permission_suggestions: unknown[];
  /** TODO: Not implemented - path that triggered the permission check */
  blocked_path: string | null;
  /** Pre-computed diff previews for file-modifying tools (Write/Edit/Patch) */
  diffs?: DiffPreview[];
}

/**
 * Request to execute an external tool (CLI → SDK)
 */
export interface ExecuteExternalToolRequest {
  subtype: "execute_external_tool";
  tool_call_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

export type CliToSdkControlRequest =
  | CanUseToolControlRequest
  | ExecuteExternalToolRequest;

// Combined for parsing
export type ControlRequestBody =
  | SdkToCliControlRequest
  | CliToSdkControlRequest;

// --- Control Response (bidirectional) ---
export interface ControlResponse extends MessageEnvelope {
  type: "control_response";
  response: ControlResponseBody;
}

export type ControlResponseBody =
  | {
      subtype: "success";
      request_id: string;
      response?: CanUseToolResponse | Record<string, unknown>;
    }
  | { subtype: "error"; request_id: string; error: string }
  | ExternalToolResultResponse;

// --- can_use_tool response payloads ---
export interface CanUseToolResponseAllow {
  behavior: "allow";
  /** Modified tool input */
  updatedInput?: Record<string, unknown> | null;
  /** TODO: Not implemented - dynamic permission rule updates */
  updatedPermissions?: unknown[];
}

export interface CanUseToolResponseDeny {
  behavior: "deny";
  message: string;
  /** TODO: Not wired up yet - infrastructure exists in TUI */
  interrupt?: boolean;
}

export type CanUseToolResponse =
  | CanUseToolResponseAllow
  | CanUseToolResponseDeny;

/**
 * External tool result content block (matches SDK AgentToolResultContent)
 */
export interface ExternalToolResultContent {
  type: "text" | "image";
  text?: string;
  data?: string; // base64 for images
  mimeType?: string;
}

/**
 * External tool result response (SDK → CLI)
 */
export interface ExternalToolResultResponse {
  subtype: "external_tool_result";
  request_id: string;
  tool_call_id: string;
  content: ExternalToolResultContent[];
  is_error: boolean;
}

// ═══════════════════════════════════════════════════════════════
// USER INPUT
// ═══════════════════════════════════════════════════════════════

/**
 * User input message for bidirectional communication.
 * Uses MessageCreate from letta-client for multimodal content support.
 */
export interface UserInput {
  type: "user";
  message: MessageCreate;
}

// ═══════════════════════════════════════════════════════════════
// STATIC TRANSCRIPT SYNC
// Emitted by the WS listen client when a remote consumer (SDK,
// desktop app) connects or reconnects mid-session. Together they
// allow the consumer to reconstruct the full session state without
// polling. See listen-client.ts for the emit sequence.
// ═══════════════════════════════════════════════════════════════

/**
 * Emitted once during the static sync phase (before sync_complete).
 * Carries committed message history for the current conversation.
 *
 * V1: always a single page (is_final: true). Pagination via multiple
 * chunks (is_final: false on all but the last) is reserved for future use.
 */
export interface TranscriptBackfillMessage extends MessageEnvelope {
  type: "transcript_backfill";
  /** Committed conversation messages in chronological order. */
  messages: LettaMessage[];
  /**
   * True when this is the only or last backfill chunk for this sync.
   * Future pagination will emit multiple chunks with is_final: false
   * on all but the last.
   */
  is_final: boolean;
}

/**
 * Emitted during the static sync phase when there are items in the
 * turn queue at connect time. Gives the consumer a point-in-time
 * snapshot of queue contents without requiring live queue events.
 *
 * Omitted entirely when the queue is empty at sync time.
 */
export interface QueueSnapshotMessage extends MessageEnvelope {
  type: "queue_snapshot";
  /** Items currently in the queue, in enqueue order. */
  items: Array<{
    item_id: string;
    kind: QueueItemKind;
    source: QueueItemSource;
  }>;
}

/**
 * Marks the end of the initial static sync phase.
 * All transcript_backfill and queue_snapshot messages are guaranteed
 * to precede this event. After sync_complete, the consumer receives
 * live queue lifecycle events (queue_item_enqueued, etc.) and message
 * stream events in real time.
 *
 * had_pending_turn: true means a turn was already in-flight when the
 * consumer connected; message chunks for that turn will follow.
 */
export interface SyncCompleteMessage extends MessageEnvelope {
  type: "sync_complete";
  had_pending_turn: boolean;
}

/**
 * Post-sync supplemental backfill. Emitted AFTER sync_complete when
 * context (agent_id / conversation_id) was not available at connect
 * time but became known from the first inbound message.
 *
 * Distinct from transcript_backfill (which is only emitted during the
 * static phase) so clients can handle it without breaking the
 * sync_complete contract. The client should replace its (empty)
 * transcript with the messages provided here.
 *
 * Emitted at most once per connection (guarded by supplementSent flag
 * in the listener runtime).
 */
export interface TranscriptSupplementMessage extends MessageEnvelope {
  type: "transcript_supplement";
  /** Committed conversation messages in chronological order. */
  messages: LettaMessage[];
}

// ═══════════════════════════════════════════════════════════════
// UNION TYPE
// ═══════════════════════════════════════════════════════════════

/**
 * Union of all wire message types that can be emitted by headless.ts
 */
export type WireMessage =
  | SystemMessage
  | ContentMessage
  | StreamEvent
  | AutoApprovalMessage
  | ErrorMessage
  | RetryMessage
  | RecoveryMessage
  | ResultMessage
  | ControlResponse
  | ControlRequest // CLI → SDK control requests (e.g., can_use_tool)
  | QueueLifecycleEvent
  | TranscriptBackfillMessage
  | QueueSnapshotMessage
  | SyncCompleteMessage
  | TranscriptSupplementMessage;
