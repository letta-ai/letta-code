/**
 * Protocol V2 (alpha hard-cut contract)
 *
 * This file defines the runtime-scoped websocket contract for device-mode UIs.
 * It is intentionally additive and isolated from protocol.ts so we can migrate
 * listener emitters/consumers in controlled steps.
 */

import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";

/**
 * Runtime identity for all state and delta events.
 */
export interface RuntimeScope {
  agent_id: string;
  conversation_id: string;
}

/**
 * Base envelope shared by all v2 websocket messages.
 *
 * event_seq:
 * - Monotonic per runtime scope
 * - Used for ordering + gap detection
 *
 * idempotency_key:
 * - Stable unique key for dedupe on reconnect/replay
 */
export interface RuntimeEnvelope {
  runtime: RuntimeScope;
  event_seq: number;
  emitted_at: string; // ISO8601
  idempotency_key: string;
}

export type DevicePermissionMode =
  | "bypass-all"
  | "default"
  | "plan"
  | "accept-edits";

export interface BackgroundProcessSummary {
  process_id: string;
  kind: "bash" | "agent_task";
  label: string;
  started_at: string; // ISO8601
  status: "running" | "completed" | "failed" | "cancelled";
}

/**
 * Bottom-bar and device execution context state.
 */
export interface DeviceStatus {
  current_connection_id: string | null;
  current_permission_mode: DevicePermissionMode;
  current_working_directory: string | null;
  letta_code_version: string | null;
  current_toolset: string[];
  current_available_skills: string[];
  background_processes: BackgroundProcessSummary[];
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

export interface QueueMessage {
  id: string;
  source: "user" | "task_notification" | "subagent" | "system";
  kind: "message" | "task_notification" | "approval_result" | "overlay_action";
  enqueued_at?: string;
}

/**
 * Loop state is intentionally small and finite.
 * Message-level details are projected from runtime deltas.
 */
export interface LoopState {
  status: LoopStatus;
  queue: QueueMessage[];
  active_run_ids: string[];
}

export interface DeviceStatusUpdateMessage extends RuntimeEnvelope {
  type: "device_status_update";
  device_status: DeviceStatus;
}

export interface LoopStatusUpdateMessage extends RuntimeEnvelope {
  type: "loop_status_update";
  loop_status: LoopState;
}

/**
 * Message-level delta with explicit identity fields required by UIs.
 */
export interface MessageDelta {
  id: string;
  date: string; // ISO8601
  message_type: LettaStreamingResponse["message_type"] | "system_message";
  run_id?: string | null;
  otid?: string | null;
  seq_id?: number | null;
  chunk: LettaStreamingResponse;
}

/**
 * Canonical approval request/response deltas for approval UI state.
 */
export interface ControlRequestDelta {
  request_id: string;
  request: Record<string, unknown>;
}

export interface ControlResponseDelta {
  request_id: string;
  subtype: "success" | "error";
  response?: Record<string, unknown>;
  error?: string;
}

/**
 * Canonical client-side tool lifecycle deltas for tool timers.
 */
export interface ClientToolStartDelta {
  tool_call_id: string;
  tool_name: string;
  run_id?: string | null;
  started_at_ms: number;
  input?: Record<string, unknown>;
}

export interface ClientToolCompleteDelta {
  tool_call_id: string;
  run_id?: string | null;
  status: "success" | "error";
  finished_at_ms: number;
  tool_return?: unknown;
}

/**
 * Canonical command lifecycle deltas for slash-command/task command projection.
 */
export interface CommandStartDelta {
  command_id: string;
  command_name: string;
  started_at_ms: number;
  args?: Record<string, unknown>;
}

export interface CommandCompleteDelta {
  command_id: string;
  command_name: string;
  finished_at_ms: number;
  status: "success" | "error" | "cancelled";
  output?: unknown;
}

/**
 * Retry/error/status deltas surfaced in TUI and chat timeline.
 */
export interface RetryNoticeDelta {
  reason: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  run_id?: string | null;
}

export interface RuntimeErrorPrintDelta {
  message: string;
  stop_reason?: string;
  run_id?: string | null;
  is_terminal: boolean;
  detail?: string;
}

export interface StatusPrintDelta {
  message: string;
  level: "info" | "success" | "warning";
}

export interface UnknownDelta {
  original_type: string;
  payload: Record<string, unknown>;
}

export type RuntimeDeltaType =
  | "message_delta"
  | "control_request"
  | "control_response"
  | "client_side_tool_start"
  | "client_side_tool_complete"
  | "command_start"
  | "command_complete"
  | "retry_notice"
  | "runtime_error_print"
  | "status_print"
  | "unknown";

export type RuntimeDeltaPayloadByType = {
  message_delta: MessageDelta;
  control_request: ControlRequestDelta;
  control_response: ControlResponseDelta;
  client_side_tool_start: ClientToolStartDelta;
  client_side_tool_complete: ClientToolCompleteDelta;
  command_start: CommandStartDelta;
  command_complete: CommandCompleteDelta;
  retry_notice: RetryNoticeDelta;
  runtime_error_print: RuntimeErrorPrintDelta;
  status_print: StatusPrintDelta;
  unknown: UnknownDelta;
};

export type RuntimeDeltaMessage = {
  [K in RuntimeDeltaType]: RuntimeEnvelope & {
    type: "runtime_delta";
    delta_type: K;
    delta: RuntimeDeltaPayloadByType[K];
  };
}[RuntimeDeltaType];

/**
 * Optional full snapshot for bootstrap/reconnect.
 */
export interface RuntimeStateSnapshot {
  messages: MessageDelta[];
  device_status: DeviceStatus | null;
  loop_status: LoopState | null;
}

export interface RuntimeStateSnapshotMessage extends RuntimeEnvelope {
  type: "runtime_state_snapshot";
  snapshot: RuntimeStateSnapshot;
}

export type WsProtocolMessage =
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | RuntimeDeltaMessage
  | RuntimeStateSnapshotMessage;
