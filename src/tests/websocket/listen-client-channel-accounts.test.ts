import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { __listenClientTestUtils } from "../../websocket/listener/client";

class MockSocket {
  public sentPayloads: string[] = [];

  constructor(public readyState: number) {}

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

const actualChannelsService = await import("../../channels/service");

afterEach(() => {
  __listenClientTestUtils.setChannelsServiceLoaderForTests(null);
});

describe("channel account list responses", () => {
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
          hasBotToken: true,
          hasAppToken: true,
          agentId: "agent-1",
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
              hasBotToken: true,
              hasAppToken: true,
              agentId: "agent-1",
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
            mode: "socket",
            dm_policy: "pairing",
            allowed_users: [],
            has_bot_token: true,
            has_app_token: true,
            agent_id: "agent-1",
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
});
