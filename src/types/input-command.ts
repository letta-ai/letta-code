import type { InputCreateMessagePayload } from "./input-create-message";
import type { ConversationRuntimeScope } from "./runtime-scope";
import type * as TeleportProtocol from "./teleport-protocol";

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

export type InputApprovalResponsePayload = {
  kind: "approval_response";
} & ApprovalResponseBody;

export type InputPayload =
  | InputCreateMessagePayload
  | InputApprovalResponsePayload
  | TeleportProtocol.InputTeleportContinuePayload;

export interface InputCommand {
  type: "input";
  request_id?: string;
  terminal_consumer_id?: string;
  runtime: ConversationRuntimeScope;
  super_run_id?: string;
  mcp_originator_token?: string;
  mcp_originator_generation?: number;
  payload: InputPayload;
}
