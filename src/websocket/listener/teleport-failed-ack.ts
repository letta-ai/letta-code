import type {
  TeleportFailedAckMessage,
  TeleportFailedCommand,
} from "@/types/teleport-protocol";
import { toListenerConnection } from "./connection";
import { emitProtocolV2Message } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ListenerConnectionId, ListenerRuntime } from "./types";

export function emitTeleportFailedAck(params: {
  listener: ListenerRuntime;
  socket: ListenerTransport;
  connectionId: ListenerConnectionId;
  command: TeleportFailedCommand;
}): void {
  const message: TeleportFailedAckMessage = {
    type: "teleport_failed_ack",
    request_id: params.command.request_id,
    teleport_id: params.command.teleport_id,
    runtime: params.command.runtime,
    accepted: true,
  };
  emitProtocolV2Message(
    params.socket,
    params.listener,
    message,
    message.runtime,
    toListenerConnection(params.connectionId),
  );
}
