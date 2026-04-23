import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { __listenClientTestUtils } from "../../websocket/listener/client";

/**
 * Regression coverage for the Telegram `transcribe_voice` field on the
 * websocket listener protocol. PR #1806 added the per-account setting on
 * the channels service layer; this test pins the wire bridge:
 *
 *  - outbound account snapshots include `transcribe_voice`
 *  - inbound `channel_account_create` forwards `transcribe_voice` into the
 *    service-layer `transcribeVoice` patch
 *  - inbound `channel_account_update` forwards `transcribe_voice` the same way
 */

class MockSocket {
  public sentPayloads: string[] = [];

  constructor(public readyState: number) {}

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }
}

const actualChannelsService = await import("../../channels/service");

function telegramSnapshot(overrides: {
  accountId: string;
  transcribeVoice: boolean;
}) {
  return {
    channelId: "telegram" as const,
    accountId: overrides.accountId,
    displayName: undefined,
    enabled: true,
    configured: true,
    running: false,
    dmPolicy: "pairing" as const,
    allowedUsers: [],
    config: {},
    hasToken: true,
    transcribeVoice: overrides.transcribeVoice,
    binding: { agentId: null, conversationId: null },
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
  };
}

afterEach(() => {
  __listenClientTestUtils.setChannelsServiceLoaderForTests(null);
});

describe("telegram transcribe_voice wire bridge", () => {
  test("outbound channel_accounts_list snapshot includes transcribe_voice", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      listChannelAccountSnapshots: () => [
        telegramSnapshot({ accountId: "tg-1", transcribeVoice: true }),
      ],
      refreshChannelAccountDisplayNameLive: () =>
        Promise.resolve(
          telegramSnapshot({ accountId: "tg-1", transcribeVoice: true }),
        ),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_accounts_list",
          request_id: "tv-list-1",
          channel_id: "telegram",
        },
        socket as unknown as WebSocket,
        runtime,
        { onStatusChange: undefined, connectionId: "conn-test" },
        async () => {},
      );

      const parsed = JSON.parse(socket.sentPayloads[0] as string);
      expect(parsed.success).toBe(true);
      expect(parsed.accounts[0]).toMatchObject({
        channel_id: "telegram",
        account_id: "tg-1",
        transcribe_voice: true,
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("channel_account_create forwards transcribe_voice to the service patch", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    const captured: Array<{ transcribeVoice?: boolean }> = [];

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      createChannelAccountLive: (
        _channelId: string,
        patch: { transcribeVoice?: boolean },
      ) => {
        captured.push(patch);
        return telegramSnapshot({
          accountId: "tg-new",
          transcribeVoice: patch.transcribeVoice === true,
        });
      },
      refreshChannelAccountDisplayNameLive: () =>
        Promise.resolve(
          telegramSnapshot({ accountId: "tg-new", transcribeVoice: true }),
        ),
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_create",
          request_id: "tv-create-1",
          channel_id: "telegram",
          account: {
            token: "fake-token",
            dm_policy: "pairing",
            allowed_users: [],
            transcribe_voice: true,
          },
        },
        socket as unknown as WebSocket,
        runtime,
        { onStatusChange: undefined, connectionId: "conn-test" },
        async () => {},
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.transcribeVoice).toBe(true);

      const parsed = JSON.parse(socket.sentPayloads[0] as string);
      expect(parsed.success).toBe(true);
      expect(parsed.account).toMatchObject({
        channel_id: "telegram",
        account_id: "tg-new",
        transcribe_voice: true,
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("channel_account_update forwards transcribe_voice to the service patch", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    const captured: Array<{ transcribeVoice?: boolean }> = [];

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      updateChannelAccountLive: (
        _channelId: string,
        _accountId: string,
        patch: { transcribeVoice?: boolean },
      ) => {
        captured.push(patch);
        return telegramSnapshot({
          accountId: "tg-1",
          transcribeVoice: patch.transcribeVoice === true,
        });
      },
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_update",
          request_id: "tv-update-1",
          channel_id: "telegram",
          account_id: "tg-1",
          patch: { transcribe_voice: false },
        },
        socket as unknown as WebSocket,
        runtime,
        { onStatusChange: undefined, connectionId: "conn-test" },
        async () => {},
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.transcribeVoice).toBe(false);

      const parsed = JSON.parse(socket.sentPayloads[0] as string);
      expect(parsed.success).toBe(true);
      expect(parsed.account).toMatchObject({
        channel_id: "telegram",
        account_id: "tg-1",
        transcribe_voice: false,
      });
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });

  test("channel_account_update omitting transcribe_voice sends undefined to the service (preserves existing)", async () => {
    const socket = new MockSocket(WebSocket.OPEN);
    const runtime = __listenClientTestUtils.createListenerRuntime();

    const captured: Array<{ transcribeVoice?: boolean }> = [];

    __listenClientTestUtils.setChannelsServiceLoaderForTests(async () => ({
      ...actualChannelsService,
      updateChannelAccountLive: (
        _channelId: string,
        _accountId: string,
        patch: { transcribeVoice?: boolean },
      ) => {
        captured.push(patch);
        return telegramSnapshot({
          accountId: "tg-1",
          transcribeVoice: true, // existing value unchanged
        });
      },
    }));

    try {
      await __listenClientTestUtils.handleChannelsProtocolCommand(
        {
          type: "channel_account_update",
          request_id: "tv-update-2",
          channel_id: "telegram",
          account_id: "tg-1",
          patch: { dm_policy: "open" },
        },
        socket as unknown as WebSocket,
        runtime,
        { onStatusChange: undefined, connectionId: "conn-test" },
        async () => {},
      );

      expect(captured).toHaveLength(1);
      expect(captured[0]?.transcribeVoice).toBeUndefined();
    } finally {
      __listenClientTestUtils.stopRuntime(runtime, true);
    }
  });
});
