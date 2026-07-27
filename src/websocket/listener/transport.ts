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

export interface RebindingWebSocketTransport {
  readonly kind: "websocket";
  readonly bufferedAmount: number;
  isOpen(): boolean;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export type ListenerTransport =
  | WebSocket
  | LocalTransport
  | RebindingWebSocketTransport;

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

export class RebindingListenerTransport implements RebindingWebSocketTransport {
  readonly kind = "websocket" as const;

  constructor(private readonly getSocket: () => WebSocket | null) {}

  get bufferedAmount(): number {
    return this.getSocket()?.bufferedAmount ?? 0;
  }

  isOpen(): boolean {
    const socket = this.getSocket();
    return !!socket && socket.readyState === WebSocket.OPEN;
  }

  send(data: string): void {
    const socket = this.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not open");
    }
    socket.send(data);
  }

  close(): void {
    const socket = this.getSocket();
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.close();
    }
  }

  terminate(): void {
    this.getSocket()?.terminate?.();
  }
}

export function isListenerTransportOpen(
  transport: ListenerTransport | null | undefined,
): boolean {
  if (!transport) return false;
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
