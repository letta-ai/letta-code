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
  payload: unknown;
};

/**
 * Send the input_accepted response for a run-input frame.
 *
 * USER_SCOPED_MCP_CONNECTIONS: an accepted input first applies its originator
 * delivery to the in-memory token store — a fresh token last-write-wins (the
 * producer re-mints per delivery and revokes the prior token) while a
 * tokenless frame clears stale authority. Rejected or dropped inputs never
 * reach the store.
 */
export function acknowledgeInputFrame(
  send: SafeSocketSend,
  socket: WebSocket,
  frame: InputAckFrame,
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
): void {
  if (accepted) recordMcpOriginatorDelivery(frame.payload);
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
