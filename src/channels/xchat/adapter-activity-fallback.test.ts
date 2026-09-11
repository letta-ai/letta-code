import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import type { CustomChannelAccount } from "@/channels/types";
import { createXChatAdapter } from "./adapter";
import {
  __testOverrideXChatRuntime,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
} from "./runtime";

let channelsRoot: string;

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-xchat-activity-test-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(() => {
  __testOverrideXChatRuntime(null);
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("falls back to polling when the activity stream requires payment", async () => {
  let activityConnections = 0;
  const sdkAdapter: XChatSdkAdapterLike = {
    botUserId: "bot-user",
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user" } }),
      getPublicKey: async () => ({ data: [{}] }),
    },
    activity: { createSubscription: async () => ({}) },
  };
  const activityClient: XChatApiClientLike = {
    chat: apiClient.chat,
    users: apiClient.users,
    stream: {
      async activity() {
        activityConnections += 1;
        throw Object.assign(new Error("HTTP 402: Payment Required"), {
          status: 402,
        });
      },
    },
  };
  __testOverrideXChatRuntime({
    sdk: async () => ({ createXchatAdapter: () => sdkAdapter }),
    xdk: async () => ({
      Client: class {
        chat: XChatApiClientLike["chat"];
        users: XChatApiClientLike["users"];
        activity?: XChatApiClientLike["activity"];
        stream?: XChatApiClientLike["stream"];

        constructor(config: { bearerToken?: string }) {
          const client = config.bearerToken ? activityClient : apiClient;
          this.chat = client.chat;
          this.users = client.users;
          this.activity = client.activity;
          this.stream = client.stream;
        }
      },
    }),
  });

  const startupLogs: string[] = [];
  const account: CustomChannelAccount = {
    channel: "xchat",
    accountId: "xchat-test",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: {
      bot_token: "xcbot_test",
      pin: "1234",
      activity_token: "app-bearer",
      poll_interval_ms: 20_000,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const adapter = createXChatAdapter(account);
  await adapter.start({ logger: (message) => startupLogs.push(message) });

  expect(activityConnections).toBe(1);
  expect(
    (adapter as unknown as { activityClient: unknown }).activityClient,
  ).toBeNull();
  expect((adapter as unknown as { pollDelayMs: number }).pollDelayMs).toBe(
    20_000,
  );
  expect(startupLogs).toContain(
    "X Chat activity stream unavailable (HTTP 402: Payment Required); using polling only until restart.",
  );
  expect(startupLogs.at(-1)).toBe(
    "X Chat connected as @bot (polling only; activity stream unavailable)",
  );
  await adapter.stop();
});
