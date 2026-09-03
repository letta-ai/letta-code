import { createHash } from "node:crypto";

export interface ListenerRuntimeStartCompleteData {
  request_id_hash?: string;
  connection_id_hash: string;
  agent_id?: string | null;
  conversation_id?: string | null;
  success: boolean;
  created_agent: boolean;
  created_conversation: boolean;
  wait_for_replay: boolean;
  duration_ms: number;
  validate_ms: number;
  resolve_agent_ms: number;
  resolve_conversation_ms: number;
  source_tags_ms: number;
  runtime_state_ms: number;
  subscribe_tools_ms: number;
  ack_ms: number;
  replay_before_ack_ms?: number;
  error_type?: string;
  version?: string;
  platform?: string;
}

export interface ListenerInputSendCompleteData {
  connection_id_hash?: string;
  agent_id?: string | null;
  conversation_id: string;
  client_message_id_hash?: string;
  client_message_count: number;
  message_count: number;
  includes_approval: boolean;
  success: boolean;
  accepted_to_core_stream_ms: number;
  prepare_listener_turn_ms: number;
  skill_content_injection_ms: number;
  core_stream_request_ms: number;
  error_type?: string;
  version?: string;
  platform?: string;
}

export function hashTelemetryCorrelationId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
