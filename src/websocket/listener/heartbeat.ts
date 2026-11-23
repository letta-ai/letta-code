import type WebSocket from "ws";
import { isDebugEnabled } from "@/utils/debug";
import {
  LISTENER_HEARTBEAT_INTERVAL_MS,
  LISTENER_PONG_TIMEOUT_MS,
} from "./constants";
import {
  getListenerTransportKind,
  isListenerTransportOpen,
  type ListenerTransport,
} from "./transport";
import type { ListenerRuntime } from "./types";

type ReportListenerError = (
  errorType: string,
  error: unknown,
  context: string,
) => void;

export interface MissedPongWatchdog {
  shouldTerminate(lastPongAt: number | null): boolean;
  recordPing(sentAt: number): void;
}

export interface ConnectionHeartbeatOptions {
  intervalMs?: number;
}

export function createMissedPongWatchdog(
  maxUnansweredPings: number,
): MissedPongWatchdog {
  let lastPingAt: number | null = null;
  let unansweredPings = 0;

  return {
    shouldTerminate(lastPongAt) {
      if (
        lastPingAt !== null &&
        lastPongAt !== null &&
        lastPongAt >= lastPingAt
      ) {
        unansweredPings = 0;
      }
      return unansweredPings >= maxUnansweredPings;
    },
    recordPing(sentAt) {
      lastPingAt = sentAt;
      unansweredPings += 1;
    },
  };
}

const lastPongAtByTransport = new WeakMap<ListenerTransport, number>();

export function recordListenerPong(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  at: number = Date.now(),
): void {
  lastPongAtByTransport.set(transport, at);
  if (runtime.socket === transport) runtime.lastPongAt = at;
}

function getListenerPongAt(transport: ListenerTransport): number | null {
  return lastPongAtByTransport.get(transport) ?? null;
}

function getListenerSocket(transport: ListenerTransport): WebSocket | null {
  return "kind" in transport ? null : transport;
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
      watchdog.shouldTerminate(getListenerPongAt(transport))
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

function sendHeartbeatPing(
  transport: ListenerTransport,
  report: ReportListenerError,
): boolean {
  if (!isListenerTransportOpen(transport)) {
    return false;
  }
  try {
    transport.send(JSON.stringify({ type: "ping" }));
    return true;
  } catch (error) {
    report("listener_ping_send_failed", error, "listener_heartbeat");
    if (isDebugEnabled()) {
      console.error("[Listen] listener_heartbeat send failed:", error);
    }
    return false;
  }
}

export function startListenerPongHeartbeat(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  report: ReportListenerError,
  options: ConnectionHeartbeatOptions = {},
): void {
  startConnectionHeartbeat(
    runtime,
    transport,
    () => {
      report(
        "listener_pong_timeout",
        new Error(
          `No relay pong within ${LISTENER_PONG_TIMEOUT_MS}ms; terminating half-open socket to force reconnect`,
        ),
        "listener_heartbeat",
      );
      (getListenerSocket(transport) ?? runtime.socket)?.terminate();
    },
    (heartbeatTransport) => sendHeartbeatPing(heartbeatTransport, report),
    options,
  );
}
