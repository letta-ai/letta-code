import WebSocket from "ws";

/**
 * Outbound side of a listener connection.
 *
 * Remote environment listeners write protocol frames to a real WebSocket.
 * Local channel listeners have no remote peer, but still run the same turn
 * processor; their outbound protocol frames are intentionally discarded.
 */
export interface LocalTransport {
  readonly kind: "local";
  readonly bufferedAmount: number;
  isOpen(): boolean;
  send(data: string): void;
}

export type ListenerTransport = WebSocket | LocalTransport;

export class LocalListenerTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;

  isOpen(): boolean {
    return true;
  }

  send(_data: string): void {
    // Local channel mode has no remote status subscriber. The agent turn still
    // executes locally; protocol/status frames are not sent anywhere.
  }
}

export function isListenerTransportOpen(transport: ListenerTransport): boolean {
  if ("isOpen" in transport && typeof transport.isOpen === "function") {
    return transport.isOpen();
  }
  return (transport as WebSocket).readyState === WebSocket.OPEN;
}

export function getListenerTransportKind(
  transport: ListenerTransport,
): "websocket" | "local" {
  return "kind" in transport ? transport.kind : "websocket";
}
