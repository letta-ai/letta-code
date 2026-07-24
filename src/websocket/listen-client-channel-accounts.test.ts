import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __setActiveChannelCredentialsStoreModeForTests,
  __setChannelSecretStoreOverrideForTests,
  getActiveChannelCredentialsStoreMode,
} from "@/channels/credential-store";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import { __listenClientTestUtils } from "@/websocket/listener/client";

class MockSocket {
  public sentPayloads: string[] = [];

  constructor(public readyState: number) {}

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

const actualChannelsService = await import("@/channels/service");

afterEach(() => {
  __listenClientTestUtils.setChannelsServiceLoaderForTests(null);
  clearChannelAccountStores();
  clearAllRoutes();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __setActiveChannelCredentialsStoreModeForTests(null);
  __setChannelSecretStoreOverrideForTests(null);
});

type ChannelsCommand = Parameters<
  typeof __listenClientTestUtils.handleChannelsProtocolCommand
>[0];

function setupInMemoryChannelStores(): void {
  clearChannelAccountStores();
  clearAllRoutes();
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

function findMessage(
  socket: MockSocket,
  type: string,
): Record<string, unknown> | undefined {
  return parseMessages(socket).find((message) => message.type === type);
}

async function expectCommandWaitsForSecretFlush(
  commandPromise: Promise<void>,
): Promise<void> {
  const result = await Promise.race([
    commandPromise.then(() => "completed" as const),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 250);
    }),
  ]);

  expect(result).toBe("pending");
}

describe("channel account list responses", () => {
  test("creates custom app accounts on the built-in custom channel", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});

    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_create",
          request_id: "custom-create-1",
          channel_id: "custom",
          account: {
            account_id: "custom-app-1",
            display_name: "Webhook.site test",
            enabled: false,
            dm_policy: "pairing",
            config: {
              url: "https://example.com/webhook",
              agent_id: "agent-1",
            },
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );

      expect(messages[0]).toMatchObject({
        type: "channel_account_create_response",
        success: true,
        channel_id: "custom",
        account: {
          channel_id: "custom",
          account_id: "custom-app-1",
          display_name: "Webhook.site test",
          config: {
            url: "https://example.com/webhook",
            agent_id: "agent-1",
          },
        },
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("return cached account snapshots without waiting for live display-name refresh", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();
    let releaseRefresh: () => void = () => {};

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelAccountSnapshots: () => [
        {
          channelId: "slack" as const,
          accountId: "slack-app-1",
          displayName: undefined,
          enabled: true,
          configured: true,
          running: false,
          mode: "socket" as const,
          dmPolicy: "pairing" as const,
          allowedUsers: [],
          config: {
            mode: "socket",
            has_bot_token: true,
            has_app_token: true,
            agent_id: "agent-1",
            default_permission_mode: "acceptEdits",
          },
          hasBotToken: true,
          hasAppToken: true,
          agentId: "agent-1",
          defaultPermissionMode: "acceptEdits" as const,
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
      refreshChannelAccountDisplayNameLive: () =>
        new Promise((resolve) => {
          releaseRefresh = () =>
            resolve({
              channelId: "slack" as const,
              accountId: "slack-app-1",
              displayName: "Slack Bot",
              enabled: true,
              configured: true,
              running: false,
              mode: "socket" as const,
              dmPolicy: "pairing" as const,
              allowedUsers: [],
              config: {
                mode: "socket",
                has_bot_token: true,
                has_app_token: true,
                agent_id: "agent-1",
                default_permission_mode: "acceptEdits",
              },
              hasBotToken: true,
              hasAppToken: true,
              agentId: "agent-1",
              defaultPermissionMode: "acceptEdits" as const,
              createdAt: "2026-04-13T00:00:00.000Z",
              updatedAt: "2026-04-13T00:00:00.000Z",
            });
        }),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "channel-accounts-list-fast-1",
          channel_id: "slack",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "channel_accounts_list_response",
        request_id: "channel-accounts-list-fast-1",
        success: true,
        channel_id: "slack",
        accounts: [
          {
            channel_id: "slack",
            account_id: "slack-app-1",
            enabled: true,
            configured: true,
            running: false,
            dm_policy: "pairing",
            allowed_users: [],
            config: {
              mode: "socket",
              has_bot_token: true,
              has_app_token: true,
              agent_id: "agent-1",
              default_permission_mode: "acceptEdits",
            },
            created_at: "2026-04-13T00:00:00.000Z",
            updated_at: "2026-04-13T00:00:00.000Z",
          },
        ],
      });
    } finally {
      releaseRefresh();
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("does not force-refresh Slack accounts that already have display names", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();
    let refreshCalls = 0;

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelAccountSnapshots: () => [
        {
          channelId: "slack" as const,
          accountId: "slack-app-1",
          displayName: "Custom Slack Name",
          enabled: true,
          configured: true,
          running: false,
          mode: "socket" as const,
          dmPolicy: "open" as const,
          allowedUsers: [],
          config: {
            mode: "socket",
            has_bot_token: true,
            has_app_token: true,
            agent_id: "agent-1",
            default_permission_mode: "standard",
          },
          hasBotToken: true,
          hasAppToken: true,
          agentId: "agent-1",
          defaultPermissionMode: "standard" as const,
          createdAt: "2026-04-13T00:00:00.000Z",
          updatedAt: "2026-04-13T00:00:00.000Z",
        },
      ],
      refreshChannelAccountDisplayNameLive: () => {
        refreshCalls += 1;
        throw new Error("Slack display-name refresh should not run");
      },
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "channel-accounts-list-custom-name-1",
          channel_id: "slack",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      expect(JSON.parse(socket.sentPayloads[0] as string)).toMatchObject({
        type: "channel_accounts_list_response",
        request_id: "channel-accounts-list-custom-name-1",
        success: true,
        channel_id: "slack",
        accounts: [
          {
            channel_id: "slack",
            account_id: "slack-app-1",
            display_name: "Custom Slack Name",
          },
        ],
      });
      expect(refreshCalls).toBe(0);
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("round-trips plugin config through create, update, list, and get", async () => {
    setupInMemoryChannelStores();

    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_create",
          request_id: "discord-create-generic-config",
          channel_id: "discord",
          account: {
            account_id: "discord-bot",
            display_name: "Discord Bot",
            enabled: false,
            dm_policy: "pairing",
            config: {
              token: "discord-token",
              agent_id: "agent-1",
              default_permission_mode: "acceptEdits",
              allowed_channels: ["channel-1"],
            },
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_update",
          request_id: "discord-update-generic-config",
          channel_id: "discord",
          account_id: "discord-bot",
          patch: {
            config: {
              agent_id: "agent-2",
              default_permission_mode: "unrestricted",
              allowed_channels: ["channel-2"],
            },
          },
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "discord-list-generic-config",
          channel_id: "discord",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_get_config",
          request_id: "discord-get-generic-config",
          channel_id: "discord",
          account_id: "discord-bot",
        },
        socket as unknown as WebSocket,
        runtime,
        {
          onStatusChange: undefined,
          connectionId: "conn-test",
        },
        async () => {},
      );

      const messages = socket.sentPayloads.map((payload) =>
        JSON.parse(payload as string),
      );

      expect(messages[0]).toMatchObject({
        type: "channel_account_create_response",
        success: true,
        account: {
          account_id: "discord-bot",
          config: {
            has_token: true,
            agent_id: "agent-1",
            default_permission_mode: "acceptEdits",
            allowed_channels: ["channel-1"],
          },
        },
      });
      expect(messages[3]).toMatchObject({
        type: "channel_account_update_response",
        success: true,
        account: {
          account_id: "discord-bot",
          config: {
            has_token: true,
            agent_id: "agent-2",
            default_permission_mode: "unrestricted",
            allowed_channels: ["channel-2"],
          },
        },
      });
      expect(messages[6]).toMatchObject({
        type: "channel_accounts_list_response",
        success: true,
        accounts: [
          {
            account_id: "discord-bot",
            config: {
              has_token: true,
              agent_id: "agent-2",
              default_permission_mode: "unrestricted",
              allowed_channels: ["channel-2"],
            },
          },
        ],
      });
      expect(messages[7]).toMatchObject({
        type: "channel_get_config_response",
        success: true,
        config: {
          account_id: "discord-bot",
          config: {
            has_token: true,
            agent_id: "agent-2",
            default_permission_mode: "unrestricted",
            allowed_channels: ["channel-2"],
          },
        },
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("Telegram account protocol commands await keyring writes before responding", async () => {
    setupInMemoryChannelStores();

    const pendingSecretOperations: Array<() => void> = [];
    __setActiveChannelCredentialsStoreModeForTests("keyring");
    __setChannelSecretStoreOverrideForTests({
      get: async () => {
        throw new Error("Secret hydration should not run for LCD commands");
      },
      set: async () =>
        new Promise<void>((resolve) => {
          pendingSecretOperations.push(resolve);
        }),
      delete: async () =>
        new Promise<boolean>((resolve) => {
          pendingSecretOperations.push(() => resolve(true));
        }),
    });
    await getActiveChannelCredentialsStoreMode();

    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();
    const commandPromises: Array<Promise<void>> = [];

    try {
      const createPromise = sendChannelCommand(
        {
          type: "channel_account_create",
          request_id: "telegram-create-keyring-pending",
          channel_id: "telegram",
          account: {
            account_id: "telegram-bot",
            display_name: "Telegram Bot",
            enabled: false,
            dm_policy: "pairing",
            config: {
              token: "telegram-token-1",
              transcribe_voice: true,
              rich_private_chat_default: false,
            },
          },
        },
        socket,
        runtime,
      );
      commandPromises.push(createPromise);
      await expectCommandWaitsForSecretFlush(createPromise);

      expect(
        findMessage(socket, "channel_account_create_response"),
      ).toBeUndefined();
      expect(pendingSecretOperations).toHaveLength(1);
      pendingSecretOperations.shift()?.();
      await createPromise;

      expect(
        findMessage(socket, "channel_account_create_response"),
      ).toMatchObject({
        type: "channel_account_create_response",
        success: true,
        channel_id: "telegram",
        account: {
          channel_id: "telegram",
          account_id: "telegram-bot",
          display_name: "Telegram Bot",
          configured: true,
          running: false,
          dm_policy: "pairing",
          config: {
            has_token: true,
            transcribe_voice: true,
            rich_private_chat_default: false,
            binding: {
              agent_id: null,
              conversation_id: null,
            },
          },
        },
      });
      expect(pendingSecretOperations).toHaveLength(0);

      const updatePromise = sendChannelCommand(
        {
          type: "channel_account_update",
          request_id: "telegram-update-keyring-pending",
          channel_id: "telegram",
          account_id: "telegram-bot",
          patch: {
            display_name: "Telegram Bot Updated",
            dm_policy: "allowlist",
            allowed_users: ["8450770457"],
            config: {
              token: "telegram-token-2",
              transcribe_voice: false,
              rich_private_chat_default: true,
            },
          },
        },
        socket,
        runtime,
      );
      commandPromises.push(updatePromise);
      await expectCommandWaitsForSecretFlush(updatePromise);

      expect(
        findMessage(socket, "channel_account_update_response"),
      ).toBeUndefined();
      expect(pendingSecretOperations).toHaveLength(1);
      pendingSecretOperations.shift()?.();
      await updatePromise;

      expect(
        findMessage(socket, "channel_account_update_response"),
      ).toMatchObject({
        type: "channel_account_update_response",
        success: true,
        channel_id: "telegram",
        account: {
          account_id: "telegram-bot",
          display_name: "Telegram Bot Updated",
          dm_policy: "allowlist",
          allowed_users: ["8450770457"],
          config: {
            has_token: true,
            transcribe_voice: false,
            rich_private_chat_default: true,
          },
        },
      });
      expect(pendingSecretOperations).toHaveLength(0);

      const deletePromise = sendChannelCommand(
        {
          type: "channel_account_delete",
          request_id: "telegram-delete-keyring-pending",
          channel_id: "telegram",
          account_id: "telegram-bot",
        },
        socket,
        runtime,
      );
      commandPromises.push(deletePromise);
      await expectCommandWaitsForSecretFlush(deletePromise);

      expect(
        findMessage(socket, "channel_account_delete_response"),
      ).toBeUndefined();
      expect(pendingSecretOperations).toHaveLength(1);
      pendingSecretOperations.shift()?.();
      await deletePromise;

      expect(
        findMessage(socket, "channel_account_delete_response"),
      ).toMatchObject({
        type: "channel_account_delete_response",
        success: true,
        channel_id: "telegram",
        account_id: "telegram-bot",
        deleted: true,
      });
      // Delete removes the keyring entry without reading it first.
      expect(pendingSecretOperations).toHaveLength(0);
    } finally {
      for (const resolveSecretOperation of pendingSecretOperations.splice(0)) {
        resolveSecretOperation();
      }
      await Promise.allSettled(commandPromises);
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("Telegram route update creates a route and binds the account through the protocol", async () => {
    setupInMemoryChannelStores();

    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    try {
      await sendChannelCommand(
        {
          type: "channel_account_create",
          request_id: "telegram-create-for-route",
          channel_id: "telegram",
          account: {
            account_id: "telegram-bot",
            display_name: "Telegram Bot",
            enabled: false,
            dm_policy: "open",
            config: {
              token: "telegram-token",
            },
          },
        },
        socket,
        runtime,
      );

      await sendChannelCommand(
        {
          type: "channel_route_update",
          request_id: "telegram-route-create",
          channel_id: "telegram",
          account_id: "telegram-bot",
          chat_id: "8450770457",
          runtime: {
            agent_id: "agent-telegram",
            conversation_id: "default",
          },
        },
        socket,
        runtime,
      );

      await sendChannelCommand(
        {
          type: "channel_get_config",
          request_id: "telegram-get-bound-config",
          channel_id: "telegram",
          account_id: "telegram-bot",
        },
        socket,
        runtime,
      );

      expect(
        findMessage(socket, "channel_route_update_response"),
      ).toMatchObject({
        type: "channel_route_update_response",
        request_id: "telegram-route-create",
        success: true,
        channel_id: "telegram",
        chat_id: "8450770457",
        route: {
          channel_id: "telegram",
          account_id: "telegram-bot",
          chat_id: "8450770457",
          agent_id: "agent-telegram",
          conversation_id: "default",
          enabled: true,
        },
      });
      expect(getRoute("telegram", "8450770457", "telegram-bot")).toEqual(
        expect.objectContaining({
          accountId: "telegram-bot",
          agentId: "agent-telegram",
          conversationId: "default",
        }),
      );
      expect(findMessage(socket, "channel_get_config_response")).toMatchObject({
        type: "channel_get_config_response",
        request_id: "telegram-get-bound-config",
        success: true,
        config: {
          channel_id: "telegram",
          account_id: "telegram-bot",
          config: {
            has_token: true,
            binding: {
              agent_id: "agent-telegram",
              conversation_id: "default",
            },
          },
        },
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("Telegram channel_set_config manages and modifies channel config through the protocol", async () => {
    setupInMemoryChannelStores();
    __setActiveChannelCredentialsStoreModeForTests("file");

    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    try {
      await sendChannelCommand(
        {
          type: "channel_account_create",
          request_id: "telegram-manage-create",
          channel_id: "telegram",
          account: {
            account_id: "telegram-managed-bot",
            display_name: "Telegram Managed Bot",
            enabled: false,
            dm_policy: "pairing",
            config: {
              token: "telegram-token",
              group_mode: "open",
              transcribe_voice: false,
              rich_private_chat_default: false,
              inbound_debounce_ms: 100,
            },
          },
        },
        socket,
        runtime,
      );

      await sendChannelCommand(
        {
          type: "channel_set_config",
          request_id: "telegram-manage-set-config",
          channel_id: "telegram",
          account_id: "telegram-managed-bot",
          config: {
            dm_policy: "allowlist",
            allowed_users: ["8450770457"],
            plugin_config: {
              group_mode: "mention-only",
              transcribe_voice: true,
              rich_private_chat_default: true,
              inbound_debounce_ms: 750,
            },
          },
        },
        socket,
        runtime,
      );

      await sendChannelCommand(
        {
          type: "channel_get_config",
          request_id: "telegram-manage-get-config",
          channel_id: "telegram",
          account_id: "telegram-managed-bot",
        },
        socket,
        runtime,
      );

      const messages = parseMessages(socket);
      expect(findMessage(socket, "channel_set_config_response")).toMatchObject({
        type: "channel_set_config_response",
        request_id: "telegram-manage-set-config",
        success: true,
        config: {
          channel_id: "telegram",
          account_id: "telegram-managed-bot",
          display_name: "Telegram Managed Bot",
          enabled: false,
          dm_policy: "allowlist",
          allowed_users: ["8450770457"],
          config: {
            has_token: true,
            group_mode: "mention-only",
            transcribe_voice: true,
            rich_private_chat_default: true,
            inbound_debounce_ms: 750,
          },
        },
      });
      expect(findMessage(socket, "channel_get_config_response")).toMatchObject({
        type: "channel_get_config_response",
        request_id: "telegram-manage-get-config",
        success: true,
        config: {
          channel_id: "telegram",
          account_id: "telegram-managed-bot",
          display_name: "Telegram Managed Bot",
          dm_policy: "allowlist",
          allowed_users: ["8450770457"],
          config: {
            has_token: true,
            group_mode: "mention-only",
            transcribe_voice: true,
            rich_private_chat_default: true,
            inbound_debounce_ms: 750,
          },
        },
      });
      expect(
        messages.filter(
          (message) => message.type === "channel_accounts_updated",
        ),
      ).toContainEqual(
        expect.objectContaining({
          channel_id: "telegram",
          account_id: "telegram-managed-bot",
        }),
      );
      expect(
        messages.filter((message) => message.type === "channels_updated"),
      ).toContainEqual(
        expect.objectContaining({
          channel_id: "telegram",
        }),
      );
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });
});
