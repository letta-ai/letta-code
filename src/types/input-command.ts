/**
 * Input commands and their payloads (Controller -> execution environment).
 *
 * Split from protocol_v2.ts: the run-input frame, the approval-response
 * body it can carry, and the payload union. `InputCommand` is the declared
 * home of the USER_SCOPED_MCP_CONNECTIONS top-level delivery fields.
 */
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
  /** Correlates acknowledgement without waiting for the turn to finish. */
  request_id?: string;
  terminal_consumer_id?: string;
  runtime: ConversationRuntimeScope;
  /**
   * USER_SCOPED_MCP_CONNECTIONS delivery contract (declared home): the
   * relay places the originator super run id and its minted
   * `mst_…` token on the TOP-LEVEL input frame, never inside the
   * user-message payload (the payload is persisted and must not carry
   * credentials). Both are absent for unattributed super runs; the
   * listener validates the raw frame before trusting either value.
   */
  super_run_id?: string;
  mcp_originator_token?: string;
  /**
   * Strictly-increasing per-run mint generation for `mcp_originator_token`.
   * Re-mints (delivery retries) carry newer generations; the listener drops
   * deliveries older than the stored entry so a zombie retry can never
   * downgrade authority. Absent means a legacy (pre-generation) producer;
   * generation-tagged entries reject generation-less deliveries.
   */
  mcp_originator_generation?: number;
  payload: InputPayload;
}
