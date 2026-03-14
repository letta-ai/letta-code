/**
 * Protocol V2 (alpha hard-cut contract)
 *
 * This file defines the runtime-scoped websocket contract for device-mode UIs.
 * It is intentionally a hard cut from protocol.ts for alpha listener transport.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Skill } from "../agent/skills";
import type { CommandFinishedEvent } from "../cli/commands/runner";
import type { PermissionMode } from "../permissions/mode";
import type {
  BackgroundProcess,
  BackgroundTask,
} from "../tools/impl/process_manager";
import type { ToolsetName, ToolsetPreference } from "../tools/toolset";
import type {
  CanUseToolResponse,
  ControlRequest,
  ControlResponse,
  ControlResponseBody,
  ErrorMessage,
  MessageWire,
  QueueLifecycleEvent,
  QueueRuntimeItemWire,
  ResultSubtype,
  RetryMessage,
  StopReasonType,
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
  task_type: BackgroundTask["subagentType"];
  description: BackgroundTask["description"];
  started_at_ms: number;
  status: BackgroundTask["status"];
  subagent_id: BackgroundTask["subagentId"];
  error?: BackgroundTask["error"];
}

export type BackgroundProcessSummary =
  | BashBackgroundProcessSummary
  | AgentTaskBackgroundProcessSummary;

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
  pending_control_requests: Array<{
    request_id: string;
    request: ControlRequest["request"];
  }>;
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

export type QueueMessage = QueueRuntimeItemWire;

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
  type: "update_device_status";
  device_status: DeviceStatus;
}

export interface LoopStatusUpdateMessage extends RuntimeEnvelope {
  type: "update_loop_status";
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

export type QueueLifecycleDelta = ProtocolPayload<QueueLifecycleEvent>;

export interface StatusPrintDelta {
  message: string;
  level: "info" | "success" | "warning";
}

export interface UnknownDelta {
  original_type: string;
  payload: Record<string, unknown>;
}

/**
 * Expanded message-delta union (Letta message deltas + runtime lifecycle deltas).
 * stream_delta is the only message stream event the WS server emits in v2.
 */
export type StreamDelta =
  | MessageDelta
  | ControlRequestDelta
  | ControlResponseDelta
  | ClientToolStartDelta
  | ClientToolCompleteDelta
  | CommandStartDelta
  | CommandCompleteDelta
  | RetryNoticeDelta
  | RuntimeErrorPrintDelta
  | QueueLifecycleDelta
  | StatusPrintDelta
  | UnknownDelta;

export interface StreamDeltaMessage extends RuntimeEnvelope {
  type: "stream_delta";
  delta: StreamDelta;
}

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
  supports_control_response?: boolean;
}

export interface InputApprovalResponsePayload {
  kind: "approval_response";
  response: ControlResponseBody;
}

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

export type WsProtocolCommand =
  | InputCommand
  | ChangeDeviceStateCommand
  | AbortMessageCommand;

export type WsProtocolMessage =
  | DeviceStatusUpdateMessage
  | LoopStatusUpdateMessage
  | StreamDeltaMessage;

export type {
  CanUseToolResponse,
  ControlRequest,
  ControlResponseBody,
  ResultSubtype,
  StopReasonType,
};
