/**
 * Run-input acknowledgement (`input_accepted` frame) with the MCP originator
 * delivery gate.
 */
import type WebSocket from "ws";
import { recordMcpOriginatorDelivery } from "@/agent/mcp-originator-tokens";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

type InputAckFrame = {
  request_id?: string;
  runtime: unknown;
  super_run_id?: string;
  mcp_originator_token?: string;
};

/**
 * Send the input_accepted response for a run-input frame.
 *
 * USER_SCOPED_MCP_CONNECTIONS: an accepted input first applies its originator
 * delivery to the in-memory token store. The delivery rides the top-level
 * relay frame, never the user-message payload. A fresh token last-write-wins
 * (the producer re-mints per delivery and revokes the prior token) while a
 * tokenless frame clears stale authority. Rejected or dropped inputs never
 * reach the store.
 *
 * `deliveryHandling` distinguishes how much trust the accept carries:
 * - "create": a FRESH admission of new work (first started/queued accept).
 *   The token may create a store entry — the accepting turn/queue owns it
 *   and its finalizer will retire it.
 * - "refresh": an accept that creates no new owner — duplicate re-acks of
 *   already-admitted inputs, or accepted approval/teleport payloads. The
 *   token may refresh an EXISTING entry (live work recovering from an ACK
 *   loss re-mints and needs the fresh token) but must never create one:
 *   post-terminal duplicates would otherwise re-insert orphaned tokens no
 *   finalizer will ever retire.
 *
 * Defaults to "create" when the ack carries a disposition (fresh admissions
 * do) and "refresh" otherwise; duplicate call sites pass "refresh"
 * explicitly because their disposition comes from the ledger.
 */
export function acknowledgeInputFrame(
  send: SafeSocketSend,
  socket: WebSocket,
  frame: InputAckFrame,
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
  deliveryHandling?: "create" | "refresh",
): void {
  if (accepted) {
    const allowCreate =
      (deliveryHandling ?? (disposition ? "create" : "refresh")) === "create";
    recordMcpOriginatorDelivery(frame, { allowCreate });
  }
  if (!frame.request_id) return;
  send(
    socket,
    {
      type: "input_accepted",
      request_id: frame.request_id,
      runtime: frame.runtime,
      accepted,
      ...(disposition ? { disposition } : {}),
      ...(error ? { error } : {}),
    },
    "input_accepted_response",
    "input",
  );
}
