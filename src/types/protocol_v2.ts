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

export type DevicePermissionModeV2 =
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
export interface DeviceStatusV2 {
  current_connection_id: string | null;
  current_permission_mode: DevicePermissionModeV2;
  current_working_directory: string | null;
  letta_code_version: string | null;
  current_toolset: string[];
  current_available_skills: string[];
  background_processes: BackgroundProcessSummary[];
}

export type LoopStatusV2 =
  | "SENDING_API_REQUEST"
  | "WAITING_FOR_API_RESPONSE"
  | "RETRYING_API_REQUEST"
  | "PROCESSING_API_RESPONSE"
  | "EXECUTING_CLIENT_SIDE_TOOL"
  | "EXECUTING_COMMAND"
  | "WAITING_ON_APPROVAL"
  | "WAITING_ON_INPUT";

export interface QueueMessageV2 {
  id: string;
  source: "user" | "task_notification" | "subagent" | "system";
  kind: "message" | "task_notification" | "approval_result" | "overlay_action";
  enqueued_at?: string;
}

/**
 * Loop state is intentionally small and finite.
 * Message-level details are projected from runtime deltas.
 */
export interface LoopStateV2 {
  status: LoopStatusV2;
  queue: QueueMessageV2[];
  active_run_ids: string[];
}

export interface DeviceStatusUpdateMessageV2 extends RuntimeEnvelope {
  type: "device_status_update";
  device_status: DeviceStatusV2;
}

export interface LoopStatusUpdateMessageV2 extends RuntimeEnvelope {
  type: "loop_status_update";
  loop_status: LoopStateV2;
}

/**
 * Message-level delta with explicit identity fields required by UIs.
 */
export interface MessageDeltaV2 {
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
export interface ControlRequestDeltaV2 {
  request_id: string;
  request: Record<string, unknown>;
}

export interface ControlResponseDeltaV2 {
  request_id: string;
  subtype: "success" | "error";
  response?: Record<string, unknown>;
  error?: string;
}

/**
 * Canonical client-side tool lifecycle deltas for tool timers.
 */
export interface ClientToolStartDeltaV2 {
  tool_call_id: string;
  tool_name: string;
  run_id?: string | null;
  started_at_ms: number;
  input?: Record<string, unknown>;
}

export interface ClientToolCompleteDeltaV2 {
  tool_call_id: string;
  run_id?: string | null;
  status: "success" | "error";
  finished_at_ms: number;
  tool_return?: unknown;
}

/**
 * Canonical command lifecycle deltas for slash-command/task command projection.
 */
export interface CommandStartDeltaV2 {
  command_id: string;
  command_name: string;
  started_at_ms: number;
  args?: Record<string, unknown>;
}

export interface CommandCompleteDeltaV2 {
  command_id: string;
  command_name: string;
  finished_at_ms: number;
  status: "success" | "error" | "cancelled";
  output?: unknown;
}

/**
 * Retry/error/status deltas surfaced in TUI and chat timeline.
 */
export interface RetryNoticeDeltaV2 {
  reason: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  run_id?: string | null;
}

export interface RuntimeErrorPrintDeltaV2 {
  message: string;
  stop_reason?: string;
  run_id?: string | null;
  is_terminal: boolean;
  detail?: string;
}

export interface StatusPrintDeltaV2 {
  message: string;
  level: "info" | "success" | "warning";
}

export interface UnknownDeltaV2 {
  original_type: string;
  payload: Record<string, unknown>;
}

export type RuntimeDeltaTypeV2 =
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

export type RuntimeDeltaPayloadByTypeV2 = {
  message_delta: MessageDeltaV2;
  control_request: ControlRequestDeltaV2;
  control_response: ControlResponseDeltaV2;
  client_side_tool_start: ClientToolStartDeltaV2;
  client_side_tool_complete: ClientToolCompleteDeltaV2;
  command_start: CommandStartDeltaV2;
  command_complete: CommandCompleteDeltaV2;
  retry_notice: RetryNoticeDeltaV2;
  runtime_error_print: RuntimeErrorPrintDeltaV2;
  status_print: StatusPrintDeltaV2;
  unknown: UnknownDeltaV2;
};

export type RuntimeDeltaMessageV2 = {
  [K in RuntimeDeltaTypeV2]: RuntimeEnvelope & {
    type: "runtime_delta";
    delta_type: K;
    delta: RuntimeDeltaPayloadByTypeV2[K];
  };
}[RuntimeDeltaTypeV2];

/**
 * Optional full snapshot for bootstrap/reconnect.
 */
export interface RuntimeStateSnapshotV2 {
  messages: MessageDeltaV2[];
  device_status: DeviceStatusV2 | null;
  loop_status: LoopStateV2 | null;
}

export interface RuntimeStateSnapshotMessageV2 extends RuntimeEnvelope {
  type: "runtime_state_snapshot";
  snapshot: RuntimeStateSnapshotV2;
}

export type WsProtocolMessageV2 =
  | DeviceStatusUpdateMessageV2
  | LoopStatusUpdateMessageV2
  | RuntimeDeltaMessageV2
  | RuntimeStateSnapshotMessageV2;
