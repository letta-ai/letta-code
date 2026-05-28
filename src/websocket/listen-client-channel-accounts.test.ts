import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
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
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
});

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

  test("refreshes Slack accounts with auto-derived display names", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();
    let refreshCalls = 0;

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelAccountSnapshots: () => [
        {
          channelId: "slack" as const,
          accountId: "slack-app-1",
          displayName: "Old Slack Name",
          displayNameSource: "auto" as const,
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
      refreshChannelAccountDisplayNameLive: async () => {
        refreshCalls += 1;
        return {
          channelId: "slack" as const,
          accountId: "slack-app-1",
          displayName: "New Slack Name",
          displayNameSource: "auto" as const,
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
        };
      },
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "channel-accounts-list-auto-name-1",
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

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refreshCalls).toBe(1);
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("round-trips plugin config through create, update, list, and get", async () => {
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});

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
});
