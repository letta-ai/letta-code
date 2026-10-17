/**
 * Run-input acknowledgement (`input_accepted` frame) with the MCP originator
 * delivery gate.
 */
import type WebSocket from "ws";
import {
  installPreGatedMcpOriginatorDelivery,
  type McpOriginatorParsedDelivery,
  recordMcpOriginatorDelivery,
} from "@/agent/mcp-originator-tokens";
import type { InputCommand } from "@/types/protocol_v2";
import { getInputDisposition } from "./input-disposition";
import { liveAcceptedInputOwnerProof } from "./input-disposition-ownership";
import type { ConversationRuntime, InputIdentity } from "./types";

export type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

/**
 * The three values every ack for one inbound frame needs; bound once per
 * message by the listener so duplicate-ack call sites stay compact.
 */
export interface InputAckTransport {
  safeSocketSend: SafeSocketSend;
  socket: WebSocket;
  frame: Parameters<typeof acknowledgeInputFrame>[2];
}

// The originator delivery fields are declared on InputCommand (the wire
// contract's home in protocol_v2.ts); this view adds the untyped runtime
// scope the ack path tolerates.
type InputAckFrame = Pick<
  InputCommand,
  | "request_id"
  | "super_run_id"
  | "mcp_originator_token"
  | "mcp_originator_generation"
> & {
  runtime: unknown;
};

/**
 * Abort-reason wire value for a pre-commit gate denial (evil-shub round-9
 * P2): attached to the rejected input_accepted frame so Cloud maps the
 * rejection to a NON-retryable terminal failure instead of redelivering
 * permanently-denied bytes (an accepted:false ack with no abortReason is
 * retryable and would remint/redeliver up to the retry ceiling for a
 * delivery that can never be admitted). camelCase to match the frame's
 * existing `disposition`/`error` fields.
 */
export const MCP_ORIGINATOR_DENIED_PERMANENT_ABORT_REASON =
  "mcp_originator_denied_permanent";

/**
 * Frame-scoped extras for acknowledgeInputFrame, supplied by the router
 * when (and only when) the frame passed through its pre-commit gate.
 */
export type InputAckExtras = {
  /**
   * Delivery already admitted by the pre-commit gate: the ack installs the
   * volatile half only and makes NO second admission decision (evil-shub
   * round-9 P1 — a re-admission here could flip already-committed work to
   * denied when a retirement lands in the gate→ack gap). `null` means the
   * gate ran and the frame carried no originator stamp, so nothing is
   * recorded. Undefined means this ack never passed the gate (duplicate /
   * refresh re-acks) and the legacy record path evaluates admission itself.
   */
  preGated?: McpOriginatorParsedDelivery | null;
  /**
   * Non-retryable terminal reason attached to the input_accepted frame;
   * emitted only for a pre-commit gate denial, never for accepted frames.
   */
  abortReason?: string;
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
 *
 * `mayRecreateOwner` is the narrow refresh-path escape hatch: when the token
 * store lost its entry (process crash) but the DURABLE input ledger still
 * shows a live accepted owner for this input, the refreshed delivery may
 * recreate the entry. Terminal disposition tombstones must not qualify —
 * they are exactly the post-terminal duplicates the refresh restriction
 * exists to reject.
 */
export function acknowledgeInputFrame(
  send: SafeSocketSend,
  socket: WebSocket,
  frame: InputAckFrame,
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
  deliveryHandling?: "create" | "refresh",
  mayRecreateOwner?: () => boolean,
  extras?: InputAckExtras,
): void {
  if (accepted) {
    const allowCreate =
      (deliveryHandling ?? (disposition ? "create" : "refresh")) === "create";
    if (extras?.preGated === null) {
      // The gate ran and the frame carried no originator stamp: nothing to
      // record, no second admission (evil-shub round-9 P1).
    } else if (extras?.preGated !== undefined) {
      // The pre-commit gate's verdict is this frame's single admission
      // decision: install the volatile half with NO re-admission. A
      // retirement racing the gate→ack gap is fenced at use time by the
      // authority recheck on every token use.
      installPreGatedMcpOriginatorDelivery(extras.preGated, {
        allowCreate,
        mayRecreateOwner,
      });
    } else {
      const verdict = recordMcpOriginatorDelivery(frame, {
        allowCreate,
        mayRecreateOwner,
      });
      if (verdict === "denied_retryable") {
        // Durable admission could not be evaluated at all (degraded authority
        // file or a failed transaction). Suppress the ACK entirely (evil-shub
        // round-6 P1): Cloud's delivery gate treats an unacked frame as
        // undeliverable and redelivers it, so the admission retries once the
        // infrastructure heals instead of the turn running headerless forever
        // while Cloud believes the token was accepted.
        console.error(
          "[input-ack] originator admission is retryable-denied; suppressing the ack so Cloud redelivers",
        );
        return;
      }
      if (verdict === "denied_permanent") {
        // This frame can NEVER be admitted — a stale generation at-or-below
        // the durable floor, a legacy delivery beneath a known generation
        // contract, a headerless/terminal run, or a malformed generation
        // (evil-shub round-8 P1 verdict split). Suppressing the ack would
        // redeliver the same bytes forever with zero chance of success, so
        // CONSUME the frame with the normal ack and continue without the
        // originator token. Reaching this branch means a refresh-path frame
        // (duplicate/approval — consuming is correct; gated frames never
        // reach this branch because their gate verdict was final).
        console.error(
          "[input-ack] originator delivery is permanently denied (stale or retired authority); consuming the frame without the token",
        );
      }
    }
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
      ...(extras?.abortReason !== undefined && !accepted
        ? { abortReason: extras.abortReason }
        : {}),
    },
    "input_accepted_response",
    "input",
  );
}

/**
 * The acknowledgeInputFrame arguments after (send, socket, frame) — the
 * tuple the listener's per-message ack closure passes through verbatim.
 */
export type InputAckArgs = [
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
  deliveryHandling?: "create" | "refresh",
  mayRecreateOwner?: () => boolean,
];

/**
 * Refresh-only re-ack for an input the durable ledger already shows as
 * admitted, carrying the live-owner proof the originator token store needs
 * before recreating a lost entry. Terminal tombstones fail the proof, so
 * post-terminal duplicates stay rejected. Returns true when the ack fired.
 */
export function acknowledgeIfAlreadyAdmitted(
  transport: InputAckTransport,
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
): boolean {
  const disposition = getInputDisposition(runtime, identity);
  if (!disposition) return false;
  acknowledgeAdmissionDuplicate(transport, runtime, identity, disposition);
  return true;
}

/**
 * Refresh-only re-ack for a disposition the admission ledger just reported
 * as duplicate. Same live-owner proof rules as acknowledgeIfAlreadyAdmitted.
 */
export function acknowledgeAdmissionDuplicate(
  transport: InputAckTransport,
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
  disposition: "started" | "queued",
): void {
  acknowledgeInputFrame(
    transport.safeSocketSend,
    transport.socket,
    transport.frame,
    true,
    undefined,
    disposition,
    "refresh",
    liveAcceptedInputOwnerProof(runtime, identity),
  );
}
