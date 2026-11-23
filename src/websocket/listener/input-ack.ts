import type WebSocket from "ws";
import {
  installPreGatedMcpOriginatorDelivery,
  type McpOriginatorParsedDelivery,
  recordMcpOriginatorDelivery,
} from "@/agent/mcp-originator-tokens";
import type { InputCommand } from "@/types/protocol_v2";
import { getInputDisposition } from "./input-disposition";
import {
  attachTerminalConsumerToLiveAcceptedInput,
  hasLiveAcceptedInputOwner,
} from "./input-disposition-ownership";
import type { ConversationRuntime, InputIdentity } from "./types";

export type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

export interface InputAckTransport {
  safeSocketSend: SafeSocketSend;
  socket: WebSocket;
  frame: Parameters<typeof acknowledgeInputFrame>[2];
}

type InputAckFrame = Pick<
  InputCommand,
  | "request_id"
  | "super_run_id"
  | "mcp_originator_token"
  | "mcp_originator_generation"
  | "terminal_consumer_id"
> & {
  runtime: unknown;
};

export const MCP_ORIGINATOR_DENIED_PERMANENT_ABORT_REASON =
  "mcp_originator_denied_permanent";

export type InputAckExtras = {
  preGated?: McpOriginatorParsedDelivery | null;
  abortReason?: string;
};

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
  let duplicateOwnerLive: boolean | undefined;
  const trackRecreateOwnerProof = mayRecreateOwner
    ? () => {
        const live = mayRecreateOwner();
        duplicateOwnerLive = duplicateOwnerLive === true || live;
        return live;
      }
    : undefined;
  if (accepted) trackRecreateOwnerProof?.();
  if (accepted) {
    const allowCreate =
      (deliveryHandling ?? (disposition ? "create" : "refresh")) === "create";
    if (extras?.preGated === null) {
    } else if (extras?.preGated !== undefined) {
      installPreGatedMcpOriginatorDelivery(extras.preGated, {
        allowCreate,
        mayRecreateOwner: trackRecreateOwnerProof,
      });
    } else {
      const verdict = recordMcpOriginatorDelivery(frame, {
        allowCreate,
        mayRecreateOwner: trackRecreateOwnerProof,
      });
      if (verdict === "denied_retryable") {
        console.error(
          "[input-ack] originator admission is retryable-denied; suppressing the ack so Cloud redelivers",
        );
        return;
      }
      if (verdict === "denied_permanent") {
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
      ...(duplicateOwnerLive === undefined
        ? {}
        : { duplicate_owner_live: duplicateOwnerLive }),
      ...(error ? { error } : {}),
      ...(extras?.abortReason !== undefined && !accepted
        ? { abortReason: extras.abortReason }
        : {}),
    },
    "input_accepted_response",
    "input",
  );
}

export type InputAckArgs = [
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
  deliveryHandling?: "create" | "refresh",
  mayRecreateOwner?: () => boolean,
];

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

export function acknowledgeAdmissionDuplicate(
  transport: InputAckTransport,
  runtime: ConversationRuntime,
  identity: InputIdentity | undefined,
  disposition: "started" | "queued",
): void {
  const terminalConsumerId =
    typeof transport.frame.terminal_consumer_id === "string"
      ? transport.frame.terminal_consumer_id
      : undefined;
  acknowledgeInputFrame(
    transport.safeSocketSend,
    transport.socket,
    transport.frame,
    true,
    undefined,
    disposition,
    "refresh",
    () =>
      terminalConsumerId
        ? attachTerminalConsumerToLiveAcceptedInput(
            runtime,
            identity,
            terminalConsumerId,
          )
        : hasLiveAcceptedInputOwner(runtime, identity),
  );
}
