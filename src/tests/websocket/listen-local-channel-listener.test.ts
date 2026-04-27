import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { telemetry } from "../../telemetry";
import {
  isListenerActive,
  startLocalChannelListener,
  stopListenerClient,
} from "../../websocket/listen-client";

describe("local channel listener", () => {
  const originalTelemetryInit = telemetry.init;

  beforeEach(() => {
    telemetry.init = mock(() => {}) as typeof telemetry.init;
  });

  afterEach(() => {
    stopListenerClient();
    telemetry.init = originalTelemetryInit;
  });

  test("starts an active listener runtime without a remote WebSocket", async () => {
    const connectedConnectionIds: string[] = [];

    await startLocalChannelListener({
      connectionId: "local-test-device",
      deviceId: "test-device",
      connectionName: "self-hosted-test",
      startCronScheduler: false,
      onConnected: (connectionId) => {
        connectedConnectionIds.push(connectionId);
      },
      onStatusChange: () => {},
      onError: (error) => {
        throw error;
      },
    });

    expect(connectedConnectionIds).toEqual(["local-test-device"]);
    expect(isListenerActive()).toBe(true);

    stopListenerClient();
    expect(isListenerActive()).toBe(false);
  });
});
