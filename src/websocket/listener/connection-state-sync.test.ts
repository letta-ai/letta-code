import { expect, test } from "bun:test";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { LocalTransport } from "./transport";
import type { StartListenerOptions } from "./types";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

test("an unsubscribed app-server connection receives no existing runtime state", async () => {
  const runtime = createRuntime();
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId: "new-client",
    wsUrl: "local://app-server",
    deviceId: "test-device",
    connectionName: "new-client",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  getOrCreateScopedRuntime(runtime, "private-agent", "private-conversation");
  openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  runtime.processServicesStarted = true;
  setActiveRuntime(runtime);

  try {
    await startConnectedListenerRuntime(
      runtime,
      transport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
      },
    );
    expect(transport.sent).toEqual([]);
  } finally {
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});

test("keeps attached App Server connections from bypassing the startup barrier", async () => {
  const runtime = createRuntime();
  const transport = new MockTransport();
  const appServerTransport = new MockTransport();
  const appServerOptions: StartListenerOptions = {
    connectionId: "app-server",
    wsUrl: "local://app-server",
    deviceId: "test-device",
    connectionName: "app-server",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  let releaseGateway!: () => void;
  let gatewayStarted!: () => void;
  const gatewayReady = new Promise<void>((resolve) => {
    releaseGateway = resolve;
  });
  const gatewayStarting = new Promise<void>((resolve) => {
    gatewayStarted = resolve;
  });
  const options: StartListenerOptions = {
    connectionId: "local-listener",
    wsUrl: "local://listener",
    deviceId: "test-device",
    connectionName: "local-listener",
    onConnected: async () => {
      await startConnectedListenerRuntime(
        runtime,
        appServerTransport,
        appServerOptions,
        async () => {},
        {
          startHeartbeat: false,
          startCronScheduler: false,
          startProcessServices: false,
        },
      );
      gatewayStarted();
      await gatewayReady;
    },
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  openListenerConnection({
    runtime,
    connectionId: appServerOptions.connectionId,
    writer: appServerTransport,
    options: appServerOptions,
  });
  setActiveRuntime(runtime);

  try {
    const start = startConnectedListenerRuntime(
      runtime,
      transport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
      },
    );
    await gatewayStarting;

    expect(runtime.processServicesStarted).toBe(false);

    releaseGateway();
    await start;
    expect(runtime.processServicesStarted).toBe(true);
  } finally {
    releaseGateway();
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});
