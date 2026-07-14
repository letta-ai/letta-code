import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { __testOverrideChannelsRoot } from "@/channels/config";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
} from "@/channels/credential-store";
import { __testOverrideRemoveUserPlugin } from "@/channels/custom/scaffolding";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
} from "@/channels/routing";
import { __listenClientTestUtils } from "@/websocket/listener/client";

afterEach(() => {
  __listenClientTestUtils.setChannelsServiceLoaderForTests(null);
  clearChannelAccountStores();
  clearAllRoutes();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __testOverrideChannelsRoot(null);
  __testOverrideRemoveUserPlugin(null);
  __setActiveChannelCredentialsStoreModeForTests(null);
  __setChannelSecretStoreOverrideForTests(null);
});

class MockSocket {
  public sentPayloads: string[] = [];

  constructor(public readyState: number) {}

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

type ChannelsCommand = Parameters<
  typeof __listenClientTestUtils.handleChannelsProtocolCommand
>[0];

function setupInMemoryChannelStores(): void {
  clearChannelAccountStores();
  clearAllRoutes();
  __setActiveChannelCredentialsStoreModeForTests("file");
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
}

async function sendChannelCommand(
  command: ChannelsCommand,
  socket: MockSocket,
  runtime: ReturnType<typeof __listenClientTestUtils.createListenerRuntime>,
): Promise<void> {
  await __listenClientTestUtils.handleChannelsProtocolCommand(
    command,
    socket as unknown as WebSocket,
    runtime,
    {
      onStatusChange: undefined,
      connectionId: "conn-test",
    },
    async () => {},
  );
}

function parseMessages(socket: MockSocket): Array<Record<string, unknown>> {
  return socket.sentPayloads.map((payload) => JSON.parse(payload as string));
}

test("channel account delete sends one success response when post-delete plugin cleanup throws", async () => {
  setupInMemoryChannelStores();

  const socket = new MockSocket(WebSocket.OPEN);
  const runtime = __listenClientTestUtils.createListenerRuntime();
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    await sendChannelCommand(
      {
        type: "channel_account_create",
        request_id: "telegram-create-cleanup",
        channel_id: "telegram",
        account: {
          account_id: "telegram-cleanup",
          display_name: "Telegram Cleanup",
          enabled: false,
          dm_policy: "pairing",
          config: { token: "telegram-token" },
        },
      },
      socket,
      runtime,
    );

    __testOverrideRemoveUserPlugin(() => {
      throw new Error("plugin cleanup failed");
    });

    await sendChannelCommand(
      {
        type: "channel_account_delete",
        request_id: "telegram-delete-cleanup",
        channel_id: "telegram",
        account_id: "telegram-cleanup",
      },
      socket,
      runtime,
    );

    const deleteResponses = parseMessages(socket).filter(
      (message) => message.type === "channel_account_delete_response",
    );
    expect(deleteResponses).toHaveLength(1);
    expect(deleteResponses[0]).toMatchObject({
      type: "channel_account_delete_response",
      request_id: "telegram-delete-cleanup",
      success: true,
      channel_id: "telegram",
      account_id: "telegram-cleanup",
      deleted: true,
    });
  } finally {
    console.warn = originalWarn;
    __listenClientTestUtils.stopRuntime(runtime, true);
    __testOverrideRemoveUserPlugin(null);
  }
});
