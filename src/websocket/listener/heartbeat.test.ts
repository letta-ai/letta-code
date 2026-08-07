import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "./client";
import { openListenerConnection } from "./connection";
import {
  createMissedPongWatchdog,
  startConnectionHeartbeat,
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
