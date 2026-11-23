import WebSocket from "ws";

export interface LocalTransport {
  readonly kind: "local";
  readonly bufferedAmount: number;
  isOpen(): boolean;
  send(data: string): void;
}

export interface RuntimeTransport {
  readonly kind: "runtime";
  readonly bufferedAmount: number;
  isOpen(): boolean;
  send(data: string): void;
}

export type ListenerTransport = WebSocket | LocalTransport | RuntimeTransport;

export class LocalListenerTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;

  isOpen(): boolean {
    return true;
  }

  send(_data: string): void {}
}

export function isListenerTransportOpen(transport: ListenerTransport): boolean {
  if ("isOpen" in transport && typeof transport.isOpen === "function") {
    return transport.isOpen();
  }
  return (transport as WebSocket).readyState === WebSocket.OPEN;
}

export function getListenerTransportKind(
  transport: ListenerTransport,
): "websocket" | "local" | "runtime" {
  return "kind" in transport ? transport.kind : "websocket";
}
