import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { UmiLifecycleMessageBase } from "./approval-classification-protocol";

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
  retry_kind?: "provider_retry" | "transport_fallback";
  provider?: string;
  from_transport?: string | null;
  to_transport?: string | null;
  error_code?: string | null;
  step_id?: string | null;
}

export interface LoopErrorMessage extends UmiLifecycleMessageBase {
  message_type: "loop_error";
  message: string;
  stop_reason: StopReasonType;
  is_terminal: boolean;
  client_message_ids?: string[];
  api_error?: LettaStreamingResponse.LettaErrorMessage;
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

export interface LoopState {
  status: LoopStatus;
  active_run_ids: string[];
  client_message_ids_by_run_id?: Record<string, string[]>;
  executing_tool_call_ids: string[];
}
