import { expect, test } from "bun:test";
import {
  closeListenerConnection,
  markListenerConnectionInitialized,
  openListenerConnection,
} from "./connection";
import { replaySubscribedConnectionState } from "./connection-state-sync";
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

function listenerOptions(connectionId: string): StartListenerOptions {
  return {
    connectionId,
    wsUrl: "local://cloud-relay",
    deviceId: "test-device",
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

async function replayRuntimeSessionId(options: {
  listener: ReturnType<typeof createRuntime>;
  transport: MockTransport;
  connectionId: string;
}): Promise<string> {
  const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
  const runtime = getOrCreateScopedRuntime(
    options.listener,
    scope.agent_id,
    scope.conversation_id,
  );
  const connectionOptions = listenerOptions(options.connectionId);
  openListenerConnection({
    runtime: options.listener,
    connectionId: options.connectionId,
    writer: options.transport,
    options: connectionOptions,
  });
  markListenerConnectionInitialized(options.listener, options.connectionId);
  await replaySubscribedConnectionState(
    options.listener,
    options.transport,
    runtime,
    scope,
    { refreshGitContext: async () => {} },
  );
  const frame = options.transport.sent
    .map((payload) => JSON.parse(payload))
    .find((candidate) => candidate.type === "update_loop_status");
  expect(frame).toBeDefined();
  return frame.loop_status.runtime_session_id;
}

test("reconnecting the same listener runtime preserves its projected session id", async () => {
  const listener = createRuntime();
  const firstSessionId = await replayRuntimeSessionId({
    listener,
    transport: new MockTransport(),
    connectionId: "cloud-relay",
  });

  closeListenerConnection(listener, "cloud-relay");

  const reconnectedSessionId = await replayRuntimeSessionId({
    listener,
    transport: new MockTransport(),
    connectionId: "cloud-relay",
  });

  expect(reconnectedSessionId).toBe(firstSessionId);
  expect(reconnectedSessionId).toBe(listener.sessionId);
});

test("a replacement listener runtime projects a different session id", async () => {
  const originalListener = createRuntime();
  const replacementListener = createRuntime();
  const connectionId = "cloud-relay";

  const originalSessionId = await replayRuntimeSessionId({
    listener: originalListener,
    transport: new MockTransport(),
    connectionId,
  });
  const replacementSessionId = await replayRuntimeSessionId({
    listener: replacementListener,
    transport: new MockTransport(),
    connectionId,
  });

  expect(originalSessionId).toBe(originalListener.sessionId);
  expect(replacementSessionId).toBe(replacementListener.sessionId);
  expect(replacementSessionId).not.toBe(originalSessionId);
});

test("an adopted connection starts recorded recovery even when process services already exist", async () => {
  const runtime = createRuntime();
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId: "conn-adopted",
    wsUrl: "local://app-server",
    deviceId: "device-1",
    connectionName: "adopted",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  runtime.processServicesStarted = true;
  setActiveRuntime(runtime);
  let recovered = false;
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
        recoverRecordedWork: async (owner) => {
          expect(owner).toBe(runtime);
          recovered = true;
        },
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(recovered).toBe(true);
  } finally {
    stopRuntime(runtime, true);
    setActiveRuntime(null);
  }
});

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

test("waits for asynchronous Git status before emitting the state sync", async () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const transport = new MockTransport();
  const connectionId = "cloud-relay";
  const options: StartListenerOptions = {
    connectionId,
    wsUrl: "local://cloud-relay",
    deviceId: "test-device",
    connectionName: "cloud-relay",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(listener, connectionId);

  let releaseGit!: () => void;
  const gitReady = new Promise<void>((resolve) => {
    releaseGit = resolve;
  });
  const refreshGitContext = async (): Promise<void> => {
    await gitReady;
  };

  const replay = replaySubscribedConnectionState(
    listener,
    transport,
    runtime,
    { agent_id: "agent-1", conversation_id: "conv-1" },
    { forceDeviceStatus: true, refreshGitContext },
  );
  await Promise.resolve();
  expect(transport.sent).toEqual([]);

  releaseGit();
  await replay;

  expect(transport.sent.map((payload) => JSON.parse(payload).type)).toEqual([
    "update_device_status",
    "update_loop_status",
    "update_queue",
    "update_subagent_state",
  ]);
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
