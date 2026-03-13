/**
 * Protocol V2 (alpha hard-cut contract)
 *
 * This file defines the runtime-scoped websocket contract for device-mode UIs.
 * It is intentionally additive and isolated from protocol.ts so we can migrate
 * listener emitters/consumers in controlled steps.
 */

import type { Skill } from "../agent/skills";
import type { CommandFinishedEvent } from "../cli/commands/runner";
import type { SubagentState } from "../cli/helpers/subagentState";
import type { PermissionMode } from "../permissions/mode";
import type { BackgroundProcess } from "../tools/impl/process_manager";
import type { ToolsetName, ToolsetPreference } from "../tools/toolset";
import type {
  ControlRequest,
  ControlResponse,
  ErrorMessage,
  MessageWire,
  QueueSnapshotMessage,
  RetryMessage,
  ToolExecutionFinishedMessage,
  ToolExecutionStartedMessage,
} from "./protocol";

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

type ProtocolEnvelopeKeys =
  | "type"
  | "session_id"
  | "uuid"
  | "event_seq"
  | "agent_id"
  | "conversation_id";

type ProtocolPayload<T> = Omit<T, ProtocolEnvelopeKeys>;

export type DevicePermissionMode = PermissionMode;

export type AvailableSkillSummary = Pick<
  Skill,
  "id" | "name" | "description" | "path" | "source"
>;

export interface BashBackgroundProcessSummary {
  process_id: string;
  kind: "bash";
  command: BackgroundProcess["command"];
  started_at_ms: number | null;
  status: BackgroundProcess["status"];
  exit_code: BackgroundProcess["exitCode"];
}

export interface AgentTaskBackgroundProcessSummary {
  process_id: string;
  kind: "agent_task";
  task_type: SubagentState["type"];
  description: SubagentState["description"];
  started_at_ms: number;
  status: SubagentState["status"];
  error?: SubagentState["error"];
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary;

/**
 * Bottom-bar and device execution context state.
 */
export interface DeviceStatus {
  current_connection_id: string | null;
  current_permission_mode: DevicePermissionMode;
  current_working_directory: string | null;
  letta_code_version: string | null;
  current_toolset: ToolsetName | null;
  current_toolset_preference: ToolsetPreference;
  current_loaded_tools: string[];
  current_available_skills: AvailableSkillSummary[];
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

export type QueueMessage = QueueSnapshotMessage["items"][number] & {
  enqueued_at?: string;
};

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
 * Canonical stream chunk payload.
 * Identity fields (id/date/otid/run_id/seq_id) are carried directly on the
 * message chunk when present in the upstream Letta response type.
 */
export type MessageDelta = ProtocolPayload<MessageWire>;

/**
 * Canonical approval request/response deltas for approval UI state.
 */
export type ControlRequestDelta = ProtocolPayload<ControlRequest>;

export type ControlResponseDelta = ProtocolPayload<ControlResponse>;

/**
 * Canonical client-side tool lifecycle deltas for tool timers.
 */
export type ClientToolStartDelta = ProtocolPayload<ToolExecutionStartedMessage>;

export type ClientToolCompleteDelta =
  ProtocolPayload<ToolExecutionFinishedMessage>;

/**
 * Canonical command lifecycle deltas for slash-command/task command projection.
 */
export type CommandStartDelta = Pick<CommandFinishedEvent, "id" | "input"> & {
  started_at_ms: number;
};

export type CommandCompleteDelta = CommandFinishedEvent & {
  finished_at_ms: number;
};

/**
 * Retry/error/status deltas surfaced in TUI and chat timeline.
 */
export type RetryNoticeDelta = ProtocolPayload<RetryMessage>;

export type RuntimeErrorPrintDelta = ProtocolPayload<ErrorMessage> & {
  is_terminal: boolean;
};

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
