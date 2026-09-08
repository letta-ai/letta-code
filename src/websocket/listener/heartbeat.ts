import {
  LISTENER_HEARTBEAT_INTERVAL_MS,
  LISTENER_PONG_TIMEOUT_MS,
} from "./constants";
import { getListenerTransportKind, type ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

export interface MissedPongWatchdog {
  shouldTerminate(lastPongAt: number | null): boolean;
  recordPing(sentAt: number): void;
}

type HeartbeatChannelState = {
  transport: ListenerTransport;
  lastPongAt: number | null;
  watchdog: MissedPongWatchdog;
};

type ConnectionHeartbeatState = {
  control: HeartbeatChannelState;
  stream: HeartbeatChannelState | null;
};

export interface ConnectionHeartbeatOptions {
  intervalMs?: number;
}

const heartbeatStateByRuntime = new WeakMap<
  ListenerRuntime,
  ConnectionHeartbeatState
>();

/**
 * Count actual unanswered heartbeat probes instead of elapsed wall time.
 *
 * A wall-clock-only watchdog cannot distinguish a dead peer from a locally
 * starved event loop. If the interval callback itself is delayed beyond the
 * timeout (CPU saturation, sleep/wake), it otherwise kills a healthy socket
 * before giving the peer a fresh ping to answer.
 */
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

function createHeartbeatChannelState(
  transport: ListenerTransport,
  maxUnansweredPings: number,
): HeartbeatChannelState {
  return {
    transport,
    lastPongAt: Date.now(),
    watchdog: createMissedPongWatchdog(maxUnansweredPings),
  };
}

function getMaxUnansweredPings(): number {
  return Math.max(
    1,
    Math.ceil(LISTENER_PONG_TIMEOUT_MS / LISTENER_HEARTBEAT_INTERVAL_MS),
  );
}

function getHeartbeatIntervalMs(options: ConnectionHeartbeatOptions): number {
  if (options.intervalMs !== undefined) return options.intervalMs;
  const override = process.env.LETTA_LISTENER_HEARTBEAT_INTERVAL_MS;
  if (override !== undefined) {
    const parsed = Number(override);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return LISTENER_HEARTBEAT_INTERVAL_MS;
}

function syncStreamHeartbeatState(
  runtime: ListenerRuntime,
  controlTransport: ListenerTransport,
  maxUnansweredPings: number,
): HeartbeatChannelState | null {
  const heartbeatState = heartbeatStateByRuntime.get(runtime);
  if (!heartbeatState) return null;

  const streamTransport = getCurrentStreamTransport(runtime, controlTransport);
  if (!streamTransport) {
    heartbeatState.stream = null;
    return null;
  }
  if (heartbeatState.stream?.transport !== streamTransport) {
    heartbeatState.stream = createHeartbeatChannelState(
      streamTransport,
      maxUnansweredPings,
    );
  }
  return heartbeatState.stream;
}

export function recordListenerPong(
  runtime: ListenerRuntime,
  transport?: ListenerTransport | null,
): void {
  const observedAt = Date.now();
  runtime.lastPongAt = observedAt;
  const heartbeatState = heartbeatStateByRuntime.get(runtime);
  if (!heartbeatState) return;

  if (!transport || transport === heartbeatState.control.transport) {
    heartbeatState.control.lastPongAt = observedAt;
    return;
  }
  if (transport === heartbeatState.stream?.transport) {
    heartbeatState.stream.lastPongAt = observedAt;
  }
}

export function startConnectionHeartbeat(
  runtime: ListenerRuntime,
  transport: ListenerTransport,
  onStale: () => void,
  sendPing: (target: ListenerTransport) => boolean,
  options: ConnectionHeartbeatOptions = {},
): void {
  runtime.lastPongAt = Date.now();
  const maxUnansweredPings = getMaxUnansweredPings();
  heartbeatStateByRuntime.set(runtime, {
    control: createHeartbeatChannelState(transport, maxUnansweredPings),
    stream: null,
  });

  runtime.heartbeatInterval = setInterval(() => {
    const heartbeatState = heartbeatStateByRuntime.get(runtime);
    if (!heartbeatState) return;
    const streamState = syncStreamHeartbeatState(
      runtime,
      transport,
      maxUnansweredPings,
    );
    const shouldWatchdog = getListenerTransportKind(transport) === "websocket";
    if (
      shouldWatchdog &&
      (heartbeatState.control.watchdog.shouldTerminate(
        heartbeatState.control.lastPongAt,
      ) ||
        (streamState?.watchdog.shouldTerminate(streamState.lastPongAt) ??
          false))
    ) {
      onStale();
      return;
    }

    const sentAt = Date.now();
    if (sendPing(transport)) {
      heartbeatState.control.watchdog.recordPing(sentAt);
    }
    if (streamState && sendPing(streamState.transport)) {
      streamState.watchdog.recordPing(sentAt);
    }
  }, getHeartbeatIntervalMs(options));
}
