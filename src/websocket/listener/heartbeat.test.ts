import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "./client";
import { openListenerConnection } from "./connection";
import {
  createMissedPongWatchdog,
  recordListenerPong,
  startConnectionHeartbeat,
  startListenerPongHeartbeat,
} from "./heartbeat";
import { clearRuntimeTimers } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { StartListenerOptions } from "./types";

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/**
 * Relay/app-server socket stand-in. Deliberately has no `kind` field so the
 * listener treats it as a real WebSocket, which is what arms the watchdog.
 */
class FakeSocket {
  readonly readyState = 1;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];
  terminateCount = 0;

  constructor(private readonly onSend?: (socket: FakeSocket) => void) {}

  send(data: string): void {
    this.sent.push(data);
    this.onSend?.(this);
  }

  terminate(): void {
    this.terminateCount += 1;
  }
}

function asTransport(socket: FakeSocket): ListenerTransport {
  return socket as unknown as ListenerTransport;
}

function createOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "local://heartbeat-test",
    deviceId: "heartbeat-device",
    connectionName: "heartbeat-listener",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

describe("listener heartbeat watchdog", () => {
  test("does not treat a delayed first interval as missed peer responses", () => {
    const watchdog = createMissedPongWatchdog(3);

    expect(watchdog.shouldTerminate(0)).toBe(false);
    watchdog.recordPing(120_000);

    expect(watchdog.shouldTerminate(0)).toBe(false);
  });

  test("terminates only after the configured number of unanswered probes", () => {
    const watchdog = createMissedPongWatchdog(3);

    for (const sentAt of [30_000, 60_000, 90_000]) {
      expect(watchdog.shouldTerminate(0)).toBe(false);
      watchdog.recordPing(sentAt);
    }

    expect(watchdog.shouldTerminate(0)).toBe(true);
  });

  test("a pong at or after the latest ping resets the missed-probe count", () => {
    const watchdog = createMissedPongWatchdog(3);

    watchdog.recordPing(30_000);
    watchdog.recordPing(60_000);
    expect(watchdog.shouldTerminate(60_000)).toBe(false);

    watchdog.recordPing(90_000);
    watchdog.recordPing(120_000);
    expect(watchdog.shouldTerminate(120_000)).toBe(false);
  });

  test("split listeners ping control and the current stream transport", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const connectionId = "split-heartbeat";
    const control = createOpenTransport();
    const firstStream = createOpenTransport();
    const replacementStream = createOpenTransport();
    const pingTargets: ListenerTransport[] = [];
    openListenerConnection({
      runtime,
      connectionId,
      writer: control,
      streamWriter: firstStream,
      options: createOptions(connectionId),
    });

    try {
      startConnectionHeartbeat(
        runtime,
        control,
        () => {},
        (target) => {
          pingTargets.push(target);
          return true;
        },
        { intervalMs: 5 },
      );
      await waitFor(
        () =>
          pingTargets.includes(control) && pingTargets.includes(firstStream),
        "split listener did not ping both transports",
      );

      const firstStreamPingCount = pingTargets.filter(
        (target) => target === firstStream,
      ).length;
      const connection = runtime.connections.get(connectionId);
      if (!connection) throw new Error("listener connection missing");
      connection.streamWriter = replacementStream;

      await waitFor(
        () => pingTargets.includes(replacementStream),
        "replacement stream transport was not pinged",
      );
      expect(
        pingTargets.filter((target) => target === firstStream),
      ).toHaveLength(firstStreamPingCount);
      expect(pingTargets).toContain(control);
    } finally {
      clearRuntimeTimers(runtime);
    }
  });

  test("single-socket listeners send only the control heartbeat", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const connectionId = "single-heartbeat";
    const control = createOpenTransport();
    const pingTargets: ListenerTransport[] = [];
    openListenerConnection({
      runtime,
      connectionId,
      writer: control,
      options: createOptions(connectionId),
    });

    try {
      startConnectionHeartbeat(
        runtime,
        control,
        () => {},
        (target) => {
          pingTargets.push(target);
          return true;
        },
        { intervalMs: 5 },
      );
      await waitFor(
        () => pingTargets.length > 0,
        "single listener did not send its control heartbeat",
      );
      expect(pingTargets.every((target) => target === control)).toBe(true);
    } finally {
      clearRuntimeTimers(runtime);
    }
  });
});

describe("cloud heartbeat with a second live connection", () => {
  /**
   * `letta listen --channels` attaches an app-server connection to the same
   * runtime as the cloud relay socket. Two live connections leave the legacy
   * `runtime.socket` handle null, so a watchdog keyed on that handle sees no
   * pong at all and kills a perfectly healthy relay socket.
   */
  function openCloudAndAppServerConnections(
    runtime: ReturnType<typeof __listenClientTestUtils.createListenerRuntime>,
    cloud: FakeSocket,
    appServer: FakeSocket,
  ): void {
    openListenerConnection({
      runtime,
      connectionId: "cloud",
      writer: asTransport(cloud),
      options: createOptions("cloud"),
    });
    openListenerConnection({
      runtime,
      connectionId: "app-server-1",
      writer: asTransport(appServer),
      options: createOptions("app-server-1"),
    });
    expect(runtime.socket).toBeNull();
  }

  test("keeps a ponging cloud socket alive while channels are attached", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    // Answer each probe the way the relay does, on the socket it arrived on.
    const cloud = new FakeSocket((socket) =>
      recordListenerPong(runtime, asTransport(socket)),
    );
    const appServer = new FakeSocket();
    const reported: string[] = [];
    openCloudAndAppServerConnections(runtime, cloud, appServer);

    try {
      startListenerPongHeartbeat(
        runtime,
        asTransport(cloud),
        (errorType) => reported.push(errorType),
        { intervalMs: 5 },
      );

      // Well past the three-missed-pong budget the watchdog enforces.
      await waitFor(
        () => cloud.sent.length >= 8,
        "cloud heartbeat did not keep probing",
      );

      expect(cloud.terminateCount).toBe(0);
      expect(reported).not.toContain("listener_pong_timeout");
      // The legacy runtime-wide handle stays null; the fix must not depend on it.
      expect(runtime.socket).toBeNull();
    } finally {
      clearRuntimeTimers(runtime);
    }
  });

  test("still terminates a cloud socket that stops answering", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const cloud = new FakeSocket();
    const appServer = new FakeSocket();
    const reported: string[] = [];
    openCloudAndAppServerConnections(runtime, cloud, appServer);

    try {
      startListenerPongHeartbeat(
        runtime,
        asTransport(cloud),
        (errorType) => reported.push(errorType),
        { intervalMs: 5 },
      );

      await waitFor(
        () => cloud.terminateCount > 0,
        "silent cloud socket was never terminated",
      );

      expect(cloud.sent.length).toBeGreaterThanOrEqual(3);
      expect(reported).toContain("listener_pong_timeout");
      // Only the starved socket is torn down, never the app-server connection.
      expect(appServer.terminateCount).toBe(0);
    } finally {
      clearRuntimeTimers(runtime);
    }
  });

  test("a pong on one socket does not vouch for another", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const cloud = new FakeSocket();
    const appServer = new FakeSocket();
    const reported: string[] = [];
    openCloudAndAppServerConnections(runtime, cloud, appServer);
    recordListenerPong(runtime, asTransport(appServer));

    try {
      startListenerPongHeartbeat(
        runtime,
        asTransport(cloud),
        (errorType) => reported.push(errorType),
        { intervalMs: 5 },
      );

      await waitFor(
        () => cloud.terminateCount > 0,
        "silent cloud socket was never terminated",
      );
      expect(reported).toContain("listener_pong_timeout");
    } finally {
      clearRuntimeTimers(runtime);
    }
  });
});
