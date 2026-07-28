import { describe, expect, test } from "bun:test";
import type { ChannelRegistryEvent } from "@/channels/registry-events";
import {
  getOrCreateProcessTransport,
  markListenerConnectionInitialized,
  openListenerConnection,
} from "@/websocket/listener/connection";
import { createRuntime } from "@/websocket/listener/lifecycle";
import type { LocalTransport } from "@/websocket/listener/transport";
import type { StartListenerOptions } from "@/websocket/listener/types";
import { handleChannelRegistryEvent } from "./channel-registry-events";

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

function addConnection(
  runtime: ReturnType<typeof createRuntime>,
  connectionId: string,
): MockTransport {
  const transport = new MockTransport();
  const options: StartListenerOptions = {
    connectionId,
    wsUrl: "local://app-server",
    deviceId: connectionId,
    connectionName: connectionId,
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime,
    connectionId,
    writer: transport,
    options,
  });
  markListenerConnectionInitialized(runtime, connectionId);
  return transport;
}

describe("process-originated channel registry events", () => {
  test("broadcasts pairing, target, and account updates to every client", () => {
    const runtime = createRuntime();
    const clientA = addConnection(runtime, "client-a");
    const clientB = addConnection(runtime, "client-b");
    const processTransport = getOrCreateProcessTransport(runtime);
    const cases: Array<{
      event: ChannelRegistryEvent;
      expectedTypes: string[];
    }> = [
      {
        event: { type: "pairings_updated", channelId: "telegram" },
        expectedTypes: ["channel_pairings_updated", "channels_updated"],
      },
      {
        event: { type: "targets_updated", channelId: "slack" },
        expectedTypes: ["channel_targets_updated", "channels_updated"],
      },
      {
        event: {
          type: "channel_account_state_updated",
          channelId: "discord",
          accountId: "bot-1",
        },
        expectedTypes: ["channel_accounts_updated", "channels_updated"],
      },
    ];

    for (const { event, expectedTypes } of cases) {
      handleChannelRegistryEvent(event, processTransport, runtime);

      for (const client of [clientA, clientB]) {
        expect(
          client.sent.map(
            (payload) => (JSON.parse(payload) as { type: string }).type,
          ),
        ).toEqual(expectedTypes);
        client.sent.length = 0;
      }
    }
  });
});
