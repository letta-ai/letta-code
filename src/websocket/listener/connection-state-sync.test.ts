import { expect, test } from "bun:test";
import { isQueueBridgeConnected } from "@/utils/message-queue-bridge";
import {
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "./lifecycle";
import { invalidateProcessServices } from "./process-services";
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

test("outbound reconnect replaces an initialization invalidated by disconnect", async () => {
  const runtime = createRuntime();
  const options: StartListenerOptions = {
    connectionId: "outbound-client",
    wsUrl: "ws://relay.test",
    deviceId: "test-device",
    connectionName: "outbound-client",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  const gates: Array<() => void> = [];
  const initializeChannels = () =>
    new Promise<void>((resolve) => {
      gates.push(resolve);
    });
  const firstTransport = new MockTransport();
  openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: firstTransport,
    options,
  });
  setActiveRuntime(runtime);

  try {
    const firstStart = startConnectedListenerRuntime(
      runtime,
      firstTransport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
        wireChannelIngress: initializeChannels,
      },
    );
    for (let attempt = 0; gates.length < 1 && attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    expect(gates).toHaveLength(1);
    expect(isQueueBridgeConnected()).toBe(true);

    invalidateProcessServices(runtime);
    suspendListenerConnection(runtime, options.connectionId);
    expect(isQueueBridgeConnected()).toBe(false);
    expect(runtime.processServicesStarted).toBe(false);
    expect(runtime.processServicesReady).not.toBeNull();

    const secondTransport = new MockTransport();
    openListenerConnection({
      runtime,
      connectionId: options.connectionId,
      writer: secondTransport,
      options,
    });
    const reconnectStart = startConnectedListenerRuntime(
      runtime,
      secondTransport,
      options,
      async () => {},
      {
        startHeartbeat: false,
        startCronScheduler: false,
        emitInitialState: false,
        wireChannelIngress: initializeChannels,
      },
    );
    await Promise.resolve();
    expect(gates).toHaveLength(1);

    gates[0]?.();
    await firstStart;
    for (let attempt = 0; gates.length < 2 && attempt < 10; attempt += 1) {
      await Promise.resolve();
    }
    expect(gates).toHaveLength(2);
    expect(isQueueBridgeConnected()).toBe(true);
    expect(runtime.processServicesStarted).toBe(false);

    gates[1]?.();
    await reconnectStart;
    expect(isQueueBridgeConnected()).toBe(true);
    expect(runtime.processServicesStarted).toBe(true);
    expect(runtime.processServicesReady).toBeNull();
    expect(runtime.processServicesReadyGeneration).toBeNull();
  } finally {
    for (const resolve of gates) resolve();
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});
