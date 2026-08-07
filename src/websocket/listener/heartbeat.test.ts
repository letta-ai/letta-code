import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "./client";
import { openListenerConnection } from "./connection";
import { createMissedPongWatchdog } from "./heartbeat";
import { startConnectedListenerRuntime, stopRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { StartListenerOptions } from "./types";

function createRecordingTransport(messages: string[]): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (data: string) => messages.push(data),
  };
}

function countPings(messages: string[]): number {
  return messages.filter((message) => {
    try {
      return (JSON.parse(message) as { type?: string }).type === "ping";
    } catch {
      return false;
    }
  }).length;
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
    const options = createOptions(connectionId);
    const controlMessages: string[] = [];
    const firstStreamMessages: string[] = [];
    const replacementStreamMessages: string[] = [];
    const control = createRecordingTransport(controlMessages);
    const firstStream = createRecordingTransport(firstStreamMessages);
    const replacementStream = createRecordingTransport(
      replacementStreamMessages,
    );
    setActiveRuntime(runtime);
    openListenerConnection({
      runtime,
      connectionId,
      writer: control,
      streamWriter: firstStream,
      options,
    });

    try {
      await startConnectedListenerRuntime(
        runtime,
        control,
        options,
        async () => {},
        {
          startCronScheduler: false,
          startProcessServices: false,
          streamTransport: firstStream,
          heartbeatIntervalMs: 5,
        },
      );
      await waitFor(
        () =>
          countPings(controlMessages) > 0 &&
          countPings(firstStreamMessages) > 0,
        "split listener did not ping both transports",
      );

      const firstStreamPingCount = countPings(firstStreamMessages);
      const connection = runtime.connections.get(connectionId);
      if (!connection) throw new Error("listener connection missing");
      connection.streamWriter = replacementStream;

      await waitFor(
        () => countPings(replacementStreamMessages) > 0,
        "replacement stream transport was not pinged",
      );
      expect(countPings(firstStreamMessages)).toBe(firstStreamPingCount);
      expect(countPings(controlMessages)).toBeGreaterThan(0);
    } finally {
      stopRuntime(runtime, true);
      setActiveRuntime(null);
    }
  });

  test("single-socket listeners send only the control heartbeat", async () => {
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const connectionId = "single-heartbeat";
    const options = createOptions(connectionId);
    const controlMessages: string[] = [];
    const control = createRecordingTransport(controlMessages);
    setActiveRuntime(runtime);
    openListenerConnection({
      runtime,
      connectionId,
      writer: control,
      options,
    });

    try {
      await startConnectedListenerRuntime(
        runtime,
        control,
        options,
        async () => {},
        {
          startCronScheduler: false,
          startProcessServices: false,
          heartbeatIntervalMs: 5,
        },
      );
      await waitFor(
        () => countPings(controlMessages) > 0,
        "single listener did not send its control heartbeat",
      );
      expect(runtime.connections.get(connectionId)?.streamWriter).toBeNull();
      expect(countPings(controlMessages)).toBeGreaterThan(0);
    } finally {
      stopRuntime(runtime, true);
      setActiveRuntime(null);
    }
  });
});
