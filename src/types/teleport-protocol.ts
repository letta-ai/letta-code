import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { RuntimeScope } from "./runtime-scope";

export interface TeleportContinuation {
  approvals: NonNullable<ApprovalCreate["approvals"]>;
}

export interface InputTeleportContinuePayload {
  kind: "teleport_continue";
  teleport_id: string;
  source: {
    device_id: string;
    connection_name: string;
  };
  continuation?: TeleportContinuation;
}

export interface TeleportProbeCommand {
  type: "teleport_probe";
  request_id: string;
  runtime: RuntimeScope;
}

export interface TeleportRequestCommand {
  type: "teleport_request";
  request_id: string;
  teleport_id: string;
  runtime: RuntimeScope;
  target: {
    connection_id: string;
    device_id: string;
    connection_name: string;
  };
}

export interface TeleportFailedCommand {
  type: "teleport_failed";
  teleport_id: string;
  runtime: RuntimeScope;
  error: string;
}

export type TeleportProtocolCommand =
  | TeleportProbeCommand
  | TeleportRequestCommand
  | TeleportFailedCommand;

export interface TeleportProbeResponseMessage {
  type: "teleport_probe_response";
  request_id: string;
  runtime: RuntimeScope;
  supported: true;
  drains_accepted_inputs: true;
  idempotent_continuation: true;
}

export interface TeleportReadyMessage {
  type: "teleport_ready";
  teleport_id: string;
  runtime: RuntimeScope;
  success: boolean;
  active_turn: boolean;
  mode?: "standard" | "acceptEdits" | "unrestricted" | "strict";
  continuation?: TeleportContinuation;
  error?: string;
}

export type TeleportProtocolMessage =
  | TeleportProbeResponseMessage
  | TeleportReadyMessage;
