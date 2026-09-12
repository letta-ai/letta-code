import { createMissedPongWatchdog } from "@/websocket/missed-pong-watchdog";
import {
  LISTENER_HEARTBEAT_INTERVAL_MS,
  LISTENER_PONG_TIMEOUT_MS,
} from "./constants";
import { getListenerTransportKind, type ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

export interface ConnectionHeartbeatOptions {
  intervalMs?: number;
}

function getCurrentStreamTransport(
  runtime: ListenerRuntime,
  controlTransport: ListenerTransport,
): ListenerTransport | null {
  for (const connection of runtime.connections.values()) {
    if (connection.writer !== controlTransport) continue;
    const streamTransport = connection.streamWriter;
    if (streamTransport && streamTransport !== controlTransport) {
      return streamTransport;
    }
  }
  return null;
}

export function startConnectionHeartbeat(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  onStale: () => void,
  sendPing: (target: ListenerTransport) => boolean,
  options: ConnectionHeartbeatOptions = {},
): void {
  runtime.lastPongAt = Date.now();
  const maxUnansweredPings = Math.max(
    1,
    Math.ceil(LISTENER_PONG_TIMEOUT_MS / LISTENER_HEARTBEAT_INTERVAL_MS),
  );
  const watchdog = createMissedPongWatchdog(maxUnansweredPings);

  runtime.heartbeatInterval = setInterval(() => {
    if (
      getListenerTransportKind(transport) === "websocket" &&
      watchdog.shouldTerminate(runtime.lastPongAt)
    ) {
      onStale();
      return;
    }

    const sentAt = Date.now();
    if (sendPing(transport)) {
      watchdog.recordPing(sentAt);
    }
    const streamTransport = getCurrentStreamTransport(runtime, transport);
    if (streamTransport) {
      sendPing(streamTransport);
    }
  }, options.intervalMs ?? LISTENER_HEARTBEAT_INTERVAL_MS);
}
