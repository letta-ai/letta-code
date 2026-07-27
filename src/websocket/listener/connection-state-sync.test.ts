import { expect, test } from "bun:test";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, startConnectedListenerRuntime } from "./lifecycle";
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
    setActiveRuntime(null);
  }
});
