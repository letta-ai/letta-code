/**
 * Wire Format Types
 *
 * These types define the JSON structure emitted by headless.ts when running
 * in stream-json mode. They enable typed consumption of the bidirectional
 * JSON protocol.
 *
 * Design principle: Compose from @letta-ai/letta-client types where possible.
 */

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  AssistantMessage as LettaAssistantMessage,
  ReasoningMessage as LettaReasoningMessage,
  LettaStreamingResponse,
  ToolCallMessage as LettaToolCallMessage,
  ToolCall,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { ToolReturnMessage as LettaToolReturnMessage } from "@letta-ai/letta-client/resources/tools";

// Re-export letta-client types that consumers may need
export type {
  LettaStreamingResponse,
  ToolCall,
  StopReasonType,
  MessageCreate,
  LettaToolReturnMessage,
};

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
  model: string;
  tools: string[];
  cwd: string;
  mcp_servers: Array<{ name: string; status: string }>;
  permission_mode: string;
  slash_commands: string[];
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
// CONTROL PROTOCOL
// ═══════════════════════════════════════════════════════════════

// Requests (external → CLI)
export interface ControlRequest {
  type: "control_request";
  request_id: string;
  request: ControlRequestBody;
}

export type ControlRequestBody =
  | { subtype: "initialize" }
  | { subtype: "interrupt" };

// Responses (CLI → external)
export interface ControlResponse extends MessageEnvelope {
  type: "control_response";
  response: ControlResponseBody;
}

export type ControlResponseBody =
  | {
      subtype: "success";
      request_id: string;
      response?: Record<string, unknown>;
    }
  | { subtype: "error"; request_id: string; error: string };

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
  | ResultMessage
  | ControlResponse;
