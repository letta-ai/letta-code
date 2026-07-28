import {
  isListenerPongStale,
  LISTENER_HEARTBEAT_INTERVAL_MS,
  LISTENER_PONG_TIMEOUT_MS,
} from "./constants";
import { getListenerTransportKind, type ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

export function startConnectionHeartbeat(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  onStale: () => void,
  sendPing: () => void,
): void {
  runtime.lastPongAt = Date.now();
  runtime.heartbeatInterval = setInterval(() => {
    if (
      getListenerTransportKind(transport) === "websocket" &&
      isListenerPongStale(
        runtime.lastPongAt,
        Date.now(),
        LISTENER_PONG_TIMEOUT_MS,
      )
    ) {
      onStale();
      return;
    }
    sendPing();
  }, LISTENER_HEARTBEAT_INTERVAL_MS);
}
