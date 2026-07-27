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

test("failed process-service initialization can be retried", async () => {
  const runtime = createRuntime();
  const firstTransport = new MockTransport();
  const firstOptions: StartListenerOptions = {
    connectionId: "first-client",
    wsUrl: "local://app-server",
    deviceId: "test-device",
    connectionName: "first-client",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime,
    connectionId: firstOptions.connectionId,
    writer: firstTransport,
    options: firstOptions,
  });
  let initializationAttempts = 0;
  const initializeChannels = async () => {
    initializationAttempts += 1;
    if (initializationAttempts === 1) {
      throw new Error("channel recovery failed");
    }
  };
  setActiveRuntime(runtime);

  try {
    await expect(
      startConnectedListenerRuntime(
        runtime,
        firstTransport,
        firstOptions,
        async () => {},
        {
          startHeartbeat: false,
          startCronScheduler: false,
          emitInitialState: false,
          wireChannelIngress: initializeChannels,
        },
      ),
    ).rejects.toThrow("channel recovery failed");
    expect(runtime.processServicesStarted).toBe(false);
    expect(runtime.processServicesReady).toBeNull();

    const secondTransport = new MockTransport();
    const secondOptions = {
      ...firstOptions,
      connectionId: "second-client",
      connectionName: "second-client",
    };
    openListenerConnection({
      runtime,
      connectionId: secondOptions.connectionId,
      writer: secondTransport,
      options: secondOptions,
    });
    await startConnectedListenerRuntime(
      runtime,
      secondTransport,
      secondOptions,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
        wireChannelIngress: initializeChannels,
      },
    );

    expect(initializationAttempts).toBe(2);
    expect(runtime.processServicesStarted).toBe(true);
  } finally {
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});
